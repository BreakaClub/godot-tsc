//! Completion and signature help: what TypeScript's language service gives for `getCompletionsAtPosition` and `getSignatureHelpItems`,
//! over the services of `bun_sema`.
//!
//! Completion lists, after `expression.` (or `?.`), the properties of the expression's type, and anywhere else the symbols in scope
//! there (`getSymbolsInScope`): types where a type is written, values and namespaces elsewhere, with the keywords that can begin a
//! statement or an expression. Nothing is offered in a comment or a string. The editor filters by what has been typed; the items say
//! what they replace (the name being typed).
//!
//! Signature help names the signatures of the call or `new` the caret is in the arguments of, the one the arguments resolve to first
//! chosen, and the parameter the caret is at.
//!
//! Positions are LSP's: a line and a character in UTF-16 code units, both from 0.

use crate::check::{MemoryHost, Positions, Runs, with_program};
use crate::navigate::At;
use bun_sema::check::services::{Child, Location, NodeRef, Row, Services, SignatureKind, SymbolFlags, SymbolOp, SymbolRef, TypeFormatFlags, TypeOp};
use bun_sema::node::{Kind, Node};
use bun_sema::program::FileId;

/// LSP's `CompletionItemKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ItemKind {
    Method = 2,
    Function = 3,
    Constructor = 4,
    Variable = 6,
    Class = 7,
    Interface = 8,
    Module = 9,
    Property = 10,
    Enum = 13,
    Keyword = 14,
    EnumMember = 20,
    TypeParameter = 25,
}

/// One completion: the name, what it is, its type (for what the project declares; the lib files' globals have none, which keeps the
/// list quick), and the order an editor shows it in: the project's names, then the lib files', then keywords.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub label: String,
    pub kind: ItemKind,
    pub detail: Option<String>,
    pub sort: u8,
}

/// The completions at a place, and the range of the name being typed there, which an item replaces.
#[derive(Debug, Default)]
pub struct Completions {
    pub items: Vec<Item>,
    /// `(line, character)` of the start and the end of the name being typed (empty if none is).
    pub replace: ((usize, usize), (usize, usize)),
}

/// The keywords that begin a statement or an expression, offered where a value can be written.
const KEYWORDS: &[&str] = &[
    "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum",
    "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "interface", "let", "new", "null",
    "return", "super", "switch", "this", "throw", "true", "try", "type", "typeof", "undefined", "var", "void", "while", "yield",
];

fn is_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$' || byte == b'#' || byte >= 0x80
}

/// Whether the byte offset `at` is in code: not in a comment, a string or the text of a template literal. A regular expression literal is
/// taken for code, which only offers completions where none are wanted.
fn is_in_code(text: &[u8], at: usize) -> bool {
    #[derive(PartialEq)]
    enum In {
        Code,
        Line,
        Block,
        Quote(u8),
        Template,
    }
    let mut state = In::Code;
    // The brace depths at which a template's `${` began: a `}` back at that depth returns to the template's text.
    let mut templates: Vec<usize> = Vec::new();
    let mut depth = 0usize;
    let mut index = 0;
    while index < at.min(text.len()) {
        let byte = text[index];
        let next = text.get(index + 1).copied();
        match state {
            In::Code => match byte {
                b'/' if next == Some(b'/') => state = In::Line,
                b'/' if next == Some(b'*') => {
                    state = In::Block;
                    index += 1;
                }
                b'\'' | b'"' => state = In::Quote(byte),
                b'`' => state = In::Template,
                b'{' => depth += 1,
                b'}' => {
                    if templates.last() == Some(&depth) {
                        templates.pop();
                        state = In::Template;
                    } else {
                        depth = depth.saturating_sub(1);
                    }
                }
                _ => {}
            },
            In::Line if byte == b'\n' => state = In::Code,
            In::Block if byte == b'*' && next == Some(b'/') => {
                state = In::Code;
                index += 1;
            }
            In::Quote(quote) => match byte {
                b'\\' => index += 1,
                b'\n' => state = In::Code,
                _ if byte == quote => state = In::Code,
                _ => {}
            },
            In::Template => match byte {
                b'\\' => index += 1,
                b'`' => state = In::Code,
                b'$' if next == Some(b'{') => {
                    templates.push(depth);
                    state = In::Code;
                    index += 1;
                }
                _ => {}
            },
            _ => {}
        }
        index += 1;
    }
    state == In::Code
}

/// The innermost node whose span holds the byte offset `at` (the file itself if none does).
fn node_around(services: &mut Services<'_, '_, '_>, file: FileId, at: u32) -> NodeRef {
    let mut found = NodeRef { file, node: Node::FILE };
    let mut work = vec![Node::FILE];
    while let Some(node) = work.pop() {
        let here = NodeRef { file, node };
        let (start, end) = services.node_span(here);
        let known = end > start;
        if known && !(start <= at && at <= end) {
            continue;
        }
        if known && node != Node::FILE {
            let (found_start, found_end) = services.node_span(found);
            if found.node == Node::FILE || (start >= found_start && end <= found_end) {
                found = here;
            }
        }
        work.extend(services.node_children(here).iter().copied());
    }
    found
}

fn item_kind(flags: SymbolFlags) -> ItemKind {
    if flags.intersects(SymbolFlags::METHOD) {
        ItemKind::Method
    } else if flags.intersects(SymbolFlags::FUNCTION) {
        ItemKind::Function
    } else if flags.intersects(SymbolFlags::CONSTRUCTOR) {
        ItemKind::Constructor
    } else if flags.intersects(SymbolFlags::CLASS) {
        ItemKind::Class
    } else if flags.intersects(SymbolFlags::INTERFACE | SymbolFlags::TYPE_ALIAS) {
        ItemKind::Interface
    } else if flags.intersects(SymbolFlags::ENUM_MEMBER) {
        ItemKind::EnumMember
    } else if flags.intersects(SymbolFlags::ENUM) {
        ItemKind::Enum
    } else if flags.intersects(SymbolFlags::MODULE) {
        ItemKind::Module
    } else if flags.intersects(SymbolFlags::TYPE_PARAMETER) {
        ItemKind::TypeParameter
    } else if flags.intersects(SymbolFlags::PROPERTY | SymbolFlags::ACCESSOR) {
        ItemKind::Property
    } else {
        ItemKind::Variable
    }
}

/// Names the checker makes up (`__type`, `__@iterator@12`, `__#1@#x`, `export=`) are not written by anyone.
fn is_written_name(name: &[u8]) -> bool {
    !name.is_empty() && !name.starts_with(b"__") && name != b"export=" && name != b"default"
}

/// An item for `symbol`, with its type if `typed`.
fn item(services: &mut Services<'_, '_, '_>, symbol: SymbolRef, meaning: SymbolFlags, typed: bool, sort: u8, around: NodeRef) -> Option<Item> {
    let info = services.symbol_info(symbol);
    if !is_written_name(info.name) {
        return None;
    }
    let label = String::from_utf8_lossy(info.name).into_owned();
    // An import is what it imports.
    let target = match info.flags.contains(SymbolFlags::ALIAS) {
        true => services.symbol_op(SymbolOp::Aliased, symbol).filter(|&s| !services.is_unknown_symbol(s)).unwrap_or(symbol),
        false => symbol,
    };
    let flags = services.symbol_info(target).flags;
    // An import of a type is no value, and one of a value no type.
    if target != symbol && !flags.intersects(meaning) {
        return None;
    }
    let detail = match typed && flags.intersects(SymbolFlags::VALUE) {
        true => {
            let ty = services.type_of_symbol(target);
            Some(String::from_utf8_lossy(&services.type_to_string(ty, Some(around), TypeFormatFlags::empty())).into_owned())
        }
        false => None,
    };
    Some(Item { label, kind: item_kind(flags), detail, sort })
}

/// Whether every declaration of `symbol` is in a lib file.
fn is_of_lib(services: &mut Services<'_, '_, '_>, symbol: SymbolRef) -> bool {
    let declarations = services.declarations(symbol).to_vec();
    !declarations.is_empty() && declarations.iter().all(|declaration| services.file_info(declaration.file).is_default_library)
}

/// The completions at `at`.
pub fn completions(host: &MemoryHost, runs: &mut Runs, at: &At<'_>) -> Completions {
    with_program(host, runs, at.config, at.lib_dir, |view| {
        let Some(file) = view.file(at.path) else {
            return Completions::default();
        };
        view.with_services(file, |services, file, text| {
            let positions = Positions::new(text);
            let caret = positions.byte_at(at.line, at.character);
            let mut start = caret;
            while start > 0 && is_name_byte(text[start - 1]) {
                start -= 1;
            }
            let mut end = caret;
            while end < text.len() && is_name_byte(text[end]) {
                end += 1;
            }
            let (_, start_line, start_character) = positions.of(start as u32);
            let (_, end_line, end_character) = positions.of(end as u32);
            let replace = ((start_line, start_character), (end_line, end_character));
            if !is_in_code(text, start) {
                return Completions { items: Vec::new(), replace };
            }
            // `expression.` or `expression?.`: the dot, past spaces.
            let mut before = start;
            while before > 0 && text[before - 1].is_ascii_whitespace() {
                before -= 1;
            }
            let after_dot = before > 0 && text[before - 1] == b'.' && !(before > 1 && text[before - 2] == b'.');
            let items = match after_dot {
                true => members(services, file, text, before - 1),
                false => in_scope(services, file, start),
            };
            Completions { items, replace }
        })
    })
}

/// The properties of the type of the expression before the dot at `dot`.
fn members(services: &mut Services<'_, '_, '_>, file: FileId, text: &[u8], dot: usize) -> Vec<Item> {
    // The expression ends at the dot, or at the `?` of `?.`, past spaces.
    let mut expression_end = if dot > 0 && text[dot - 1] == b'?' { dot - 1 } else { dot };
    while expression_end > 0 && text[expression_end - 1].is_ascii_whitespace() {
        expression_end -= 1;
    }
    // The access whose object ends there: the innermost, if accesses nest.
    let mut found: Option<(u32, NodeRef)> = None;
    let mut work = vec![Node::FILE];
    while let Some(node) = work.pop() {
        let here = NodeRef { file, node };
        if matches!(services.node_kind(here), Kind::PropertyAccessExpression | Kind::QualifiedName) {
            let object = NodeRef { file, node: services.node_children(here).first().copied().unwrap_or(Node::NONE) };
            let (object_start, object_end) = services.node_span(object);
            if object.node.is_some() && object_end as usize == expression_end && found.is_none_or(|(start, _)| object_start > start) {
                found = Some((object_start, object));
            }
        }
        work.extend(services.node_children(here).iter().copied());
    }
    let Some((_, object)) = found else {
        return Vec::new();
    };
    let ty = services.type_at_location(object);
    let ty = services.type_op(TypeOp::Apparent, ty).unwrap_or(ty);
    let properties = services.properties_of_type(ty).to_vec();
    let mut items: Vec<Item> = properties.into_iter().filter_map(|property| item(services, property, SymbolFlags::all(), true, 0, object)).collect();
    items.sort_by(|a, b| a.label.cmp(&b.label));
    items.dedup_by(|a, b| a.label == b.label);
    items
}

/// The symbols in scope at the name that starts at `start` (or the caret, if none is typed yet), with keywords where a value goes.
fn in_scope(services: &mut Services<'_, '_, '_>, file: FileId, start: usize) -> Vec<Item> {
    let typed = services.node(Location { row: Row::NameAt(start as u32), part: None });
    let around = match typed.is_some() {
        true => NodeRef { file, node: typed },
        false => node_around(services, file, start as u32),
    };
    // Where a type is written: the name of a type reference, or a type node around the caret.
    let parent = NodeRef { file, node: services.node_parent(around) };
    let in_type = services.node_kind(around).is_type_node()
        || (typed.is_some() && services.node_kind(parent) == Kind::TypeReference)
        || (typed.is_some() && services.node_kind(parent).is_type_node());
    let meaning = match in_type {
        true => SymbolFlags::TYPE | SymbolFlags::NAMESPACE | SymbolFlags::ALIAS,
        false => SymbolFlags::VALUE | SymbolFlags::NAMESPACE | SymbolFlags::ALIAS,
    };
    let symbols = services.symbols_in_scope(around, meaning);
    let mut items = Vec::new();
    for symbol in symbols {
        let of_lib = is_of_lib(services, symbol);
        if let Some(found) = item(services, symbol, meaning, !of_lib, if of_lib { 1 } else { 0 }, around) {
            items.push(found);
        }
    }
    if !in_type {
        items.extend(KEYWORDS.iter().map(|keyword| Item { label: keyword.to_string(), kind: ItemKind::Keyword, detail: None, sort: 2 }));
    }
    items.sort_by(|a, b| (a.sort, &a.label).cmp(&(b.sort, &b.label)));
    items.dedup_by(|a, b| a.label == b.label);
    items
}

/// One signature: its label, the range of each parameter in the label (UTF-16 offsets), and the parameter a rest parameter absorbs from.
#[derive(Debug, PartialEq, Eq)]
pub struct Signature {
    pub label: String,
    pub parameters: Vec<(usize, usize)>,
    pub rest: Option<usize>,
}

/// The signatures of the call around `at`, the one to show first, and the parameter the caret is at.
#[derive(Debug, PartialEq, Eq)]
pub struct SignatureHelp {
    pub signatures: Vec<Signature>,
    pub active_signature: usize,
    pub active_parameter: usize,
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The signature help at `at`, or `None` if the caret is not in the arguments of a call.
pub fn signature_help(host: &MemoryHost, runs: &mut Runs, at: &At<'_>) -> Option<SignatureHelp> {
    with_program(host, runs, at.config, at.lib_dir, |view| {
        let file = view.file(at.path)?;
        view.with_services(file, |services, file, text| {
            let caret = Positions::new(text).byte_at(at.line, at.character);
            if !is_in_code(text, caret) {
                return None;
            }
            // The innermost call whose argument list holds the caret: after the callee's `(`, and before its `)` if it has one.
            let mut found: Option<(u32, NodeRef, usize)> = None;
            let mut work = vec![Node::FILE];
            while let Some(node) = work.pop() {
                let here = NodeRef { file, node };
                if matches!(services.node_kind(here), Kind::CallExpression | Kind::NewExpression) {
                    let (start, end) = services.node_span(here);
                    let callee = NodeRef { file, node: services.node_children(here).first().copied().unwrap_or(Node::NONE) };
                    let (_, callee_end) = services.node_span(callee);
                    let open = text[callee_end as usize..].iter().position(|&b| b == b'(').map(|n| callee_end as usize + n);
                    let closed = end > start && text.get(end as usize - 1) == Some(&b')');
                    if let Some(open) = open
                        && open < caret
                        && (caret < end as usize || (!closed && caret <= end as usize))
                        && found.is_none_or(|(found_start, _, _)| start >= found_start)
                    {
                        found = Some((start, here, open));
                    }
                }
                work.extend(services.node_children(here).iter().copied());
            }
            let (_, call, open) = found?;
            let callee = NodeRef { file, node: services.node_children(call).first().copied()? };
            let kind = match services.node_kind(call) {
                Kind::NewExpression => SignatureKind::Construct,
                _ => SignatureKind::Call,
            };
            let ty = services.type_at_location(callee);
            let ty = services.type_op(TypeOp::Apparent, ty).unwrap_or(ty);
            let candidates = services.signatures_of_type(ty, kind).to_vec();
            if candidates.is_empty() {
                return None;
            }
            let resolved = services.resolved_signature(call);
            let name = match services.node_kind(callee) {
                Kind::Identifier => String::from_utf8_lossy(services.node_text(callee)).into_owned(),
                Kind::PropertyAccessExpression => {
                    let name = NodeRef { file, node: services.node_child(callee, Child::Name) };
                    String::from_utf8_lossy(services.node_text(name)).into_owned()
                }
                _ => String::new(),
            };
            let mut signatures = Vec::new();
            let mut active_signature = 0;
            for (index, &signature) in candidates.iter().enumerate() {
                if Some(signature) == resolved {
                    active_signature = index;
                }
                // The checker prints the signature as TypeScript does (`(a: Point, ...rest: number[]): number`, with `<T>` before it if it is
                // generic); each parameter is found in that text.
                let printed = String::from_utf8_lossy(&services.signature_to_string(signature)).into_owned();
                let prefix = format!("{}{name}", if kind == SignatureKind::Construct { "new " } else { "" });
                let label = format!("{prefix}{printed}");
                let offset = utf16_len(&prefix);
                let found = parameters_in(&printed);
                let rest = found.iter().position(|&(from, _)| printed[from..].starts_with("..."));
                let parameters = found.iter().map(|&(from, to)| (offset + utf16_len(&printed[..from]), offset + utf16_len(&printed[..to]))).collect();
                signatures.push(Signature { label, parameters, rest });
            }
            let active_parameter = argument_index(&text[open + 1..caret]);
            Some(SignatureHelp { signatures, active_signature, active_parameter })
        })
    })
}

/// The byte ranges of the parameters in a printed signature: the text between its first `(` (after the type parameters) and the `)` that
/// closes it, split at its top-level commas, without the spaces around each.
fn parameters_in(printed: &str) -> Vec<(usize, usize)> {
    let bytes = printed.as_bytes();
    let mut depth = 0usize;
    let mut open = None;
    let mut ranges = Vec::new();
    let mut from = 0;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        match byte {
            b'\'' | b'"' | b'`' => {
                // A string literal type: skip to its end.
                index += 1;
                while index < bytes.len() && bytes[index] != byte {
                    index += if bytes[index] == b'\\' { 2 } else { 1 };
                }
            }
            // `=>` is no bracket.
            b'=' if bytes.get(index + 1) == Some(&b'>') => index += 1,
            b'(' | b'[' | b'{' | b'<' => {
                if byte == b'(' && depth == 0 && open.is_none() {
                    open = Some(index);
                    from = index + 1;
                }
                depth += 1;
            }
            b')' | b']' | b'}' | b'>' => {
                depth = depth.saturating_sub(1);
                if byte == b')' && depth == 0 && open.is_some() {
                    if !printed[from..index].trim().is_empty() {
                        ranges.push(trimmed(printed, from, index));
                    }
                    return ranges;
                }
            }
            b',' if depth == 1 && open.is_some() => {
                ranges.push(trimmed(printed, from, index));
                from = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    ranges
}

fn trimmed(text: &str, from: usize, to: usize) -> (usize, usize) {
    let part = &text[from..to];
    let start = from + (part.len() - part.trim_start().len());
    (start, start + part.trim().len())
}

/// Which argument the end of `arguments` (the text from after `(` to the caret) is in: the commas outside brackets, strings and comments.
fn argument_index(arguments: &[u8]) -> usize {
    let mut depth = 0usize;
    let mut commas = 0;
    for (index, &byte) in arguments.iter().enumerate() {
        if !is_in_code(arguments, index) {
            continue;
        }
        match byte {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth = depth.saturating_sub(1),
            b',' if depth == 0 => commas += 1,
            _ => {}
        }
    }
    commas
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_is_told_from_comments_strings_and_templates() {
        let text = b"a // b\nc /* d */ e 'f' \"g\" `h ${i} j` k";
        let at = |needle: &str| text.windows(needle.len()).position(|w| w == needle.as_bytes()).unwrap();
        for code in ["a", "c", "e", "i", "k"] {
            assert!(is_in_code(text, at(code)), "{code} is code");
        }
        for other in ["b", "d", "f", "g", "h", "j"] {
            assert!(!is_in_code(text, at(other)), "{other} is not code");
        }
    }

    #[test]
    fn parameters_are_found_in_a_printed_signature() {
        let printed = "<T extends { a: 1, b: 2 }>(f: (x: T, y: T) => void, s: \"a, b\", ...rest: [T, T][]): Map<T, T>";
        let found: Vec<&str> = parameters_in(printed).into_iter().map(|(from, to)| &printed[from..to]).collect();
        assert_eq!(found, ["f: (x: T, y: T) => void", "s: \"a, b\"", "...rest: [T, T][]"]);
        assert!(parameters_in("(): void").is_empty());
    }

    #[test]
    fn the_argument_is_counted_by_the_commas_outside_brackets() {
        assert_eq!(argument_index(b""), 0);
        assert_eq!(argument_index(b"a, "), 1);
        assert_eq!(argument_index(b"f(1, 2), [3, 4], { a: 1, b: 2 }, "), 3);
        assert_eq!(argument_index(b"'a, b', `c, ${d, e}`, "), 2);
    }
}
