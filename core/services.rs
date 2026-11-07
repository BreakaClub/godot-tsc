//! Editor services over the program the checker built: what a language server answers, from the services of `bun_sema` (the API
//! TypeScript's own checker gives a language service). Positions are UTF-16 offsets into the file's text, as everywhere in the protocol;
//! the checker's are bytes of its UTF-8 text.

use crate::check::{self, MemoryHost, Positions, Runs};
use bun_sema::check::services::{Child, Location, NodeRef, Row, TypeFormatFlags};
use bun_sema::node::{Kind, Node};

/// The byte offset in `text` (UTF-8) of the UTF-16 offset `units`, or the end of the text if it is past it.
fn byte_of(text: &[u8], units: usize) -> usize {
    let mut seen = 0;
    for (at, &byte) in text.iter().enumerate() {
        if byte & 0xC0 != 0x80 {
            if seen >= units {
                return at;
            }
            // A four-byte sequence is two UTF-16 units.
            seen += if byte >= 0xF0 { 2 } else { 1 };
        }
    }
    text.len()
}

/// The byte offset where the name that contains `byte` begins: the checker finds the node that *starts* at an offset, and a pointer is
/// somewhere in the middle of a name.
fn name_start(text: &[u8], mut byte: usize) -> usize {
    let is_part = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80;
    while byte > 0 && byte <= text.len() && is_part(text[byte - 1]) && text.get(byte).is_some_and(|&b| is_part(b)) {
        byte -= 1;
    }
    byte
}

/// What the person pointing at `offset` is shown: the name under the pointer and its type, as TypeScript's quick info has them.
///
/// ```json
/// {"ok":true,"hover":{"start":n,"end":n,"name":"label","type":"string"}}   or   {"ok":true,"hover":null}
/// ```
pub fn hover(host: &MemoryHost, runs: &mut Runs, config: &[u8], lib_dir: &[u8], path: &[u8], offset: usize) -> String {
    let found = check::with_services_of(host, runs, config, lib_dir, path, |services, file, text| {
        let at = u32::try_from(name_start(text, byte_of(text, offset))).expect("a file is under 4 GiB");
        let node = services.node(Location { row: Row::NameAt(at), part: None });
        if node.is_none() {
            return None;
        }
        let node = NodeRef { file, node };
        let ty = services.type_at_location(node);
        let shown = services.type_to_string(ty, Some(node), TypeFormatFlags::NO_TRUNCATION);
        let name = services.symbol_at_location(node).map(|symbol| services.symbol_info(symbol).name.to_vec()).unwrap_or_default();
        let (start, end) = services.node_span(node);
        let positions = Positions::new(text);
        Some((positions.of(start).0, positions.of(end).0, name, shown))
    });
    let Some(Some((start, end, name, shown))) = found else {
        return String::from("{\"ok\":true,\"hover\":null}");
    };
    let mut out = format!("{{\"ok\":true,\"hover\":{{\"start\":{start},\"end\":{end},\"name\":");
    check::string(&mut out, &name);
    out.push_str(",\"type\":");
    check::string(&mut out, &shown);
    out.push_str("}}");
    out
}

/// How many parameter names an argument list gets: none, those of arguments that are literals (the editors' usual choice), or all of
/// them but the arguments that are the parameter's own name.
#[derive(Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ParameterNames {
    None,
    Literals,
    All,
}

/// What an inlay hint is a hint of: the type TypeScript inferred for a declaration that names none, or the name of the parameter an
/// argument is for. `position` is the UTF-16 offset the label is drawn at; a type hint follows the declaration's name, a parameter hint
/// precedes its argument.
struct Hint {
    position: usize,
    label: String,
    kind: &'static str,
}

fn is_literal(kind: Kind) -> bool {
    matches!(
        kind,
        Kind::StringLiteral
            | Kind::NumericLiteral
            | Kind::BigIntLiteral
            | Kind::RegularExpressionLiteral
            | Kind::NoSubstitutionTemplateLiteral
            | Kind::TrueKeyword
            | Kind::FalseKeyword
            | Kind::NullKeyword
            | Kind::ObjectLiteralExpression
            | Kind::ArrayLiteralExpression
    )
}

/// The inlay hints of the file at `path` between the UTF-16 offsets `from` and `to`: the inferred types of the variables that name none,
/// and the parameter names of the arguments of calls.
///
/// ```json
/// {"ok":true,"hints":[{"position":n,"label":": string","kind":"type"},{"position":n,"label":"initialState:","kind":"parameter"}]}
/// ```
pub fn inlay_hints(
    host: &MemoryHost,
    runs: &mut Runs,
    config: &[u8],
    lib_dir: &[u8],
    path: &[u8],
    from: usize,
    to: usize,
    names: ParameterNames,
) -> String {
    let found = check::with_services_of(host, runs, config, lib_dir, path, |services, file, text| {
        let positions = Positions::new(text);
        let (from, to) = (byte_of(text, from), byte_of(text, to));
        let mut hints: Vec<Hint> = Vec::new();
        let mut work = vec![Node::FILE];
        while let Some(node) = work.pop() {
            let at = NodeRef { file, node };
            let (start, end) = services.node_span(at);
            // A node outside the range has nothing inside it in range, except the file itself and nodes whose span is unknown.
            if node != Node::FILE && end > start && (end as usize <= from || start as usize >= to) {
                continue;
            }
            match services.node_kind(at) {
                Kind::VariableDeclaration => {
                    let name = NodeRef { file, node: services.node_child(at, Child::Name) };
                    let written = services.node_child(at, Child::Type).is_some();
                    let initializer = services.node_child(at, Child::Initializer);
                    if !written
                        && initializer.is_some()
                        && services.node_kind(name) == Kind::Identifier
                        && !is_literal(services.node_kind(NodeRef { file, node: initializer }))
                    {
                        let ty = services.type_at_location(name);
                        let shown = services.type_to_string(ty, Some(name), TypeFormatFlags::NO_TRUNCATION);
                        let (_, name_end) = services.node_span(name);
                        hints.push(Hint {
                            position: positions.of(name_end).0,
                            label: format!(": {}", String::from_utf8_lossy(&shown)),
                            kind: "type",
                        });
                    }
                }
                Kind::CallExpression | Kind::NewExpression if names != ParameterNames::None => {
                    if let Some(signature) = services.resolved_signature(at) {
                        let parameters = services.signature_info(signature).parameters;
                        let children = services.node_children(at).to_vec();
                        // The callee, then the type arguments, then the arguments.
                        let arguments: Vec<Node> = children
                            .iter()
                            .skip(1)
                            .copied()
                            .filter(|&child| !services.node_kind(NodeRef { file, node: child }).is_type_node())
                            .collect();
                        for (index, &argument) in arguments.iter().enumerate() {
                            let Some(&parameter) = parameters.get(index) else { break };
                            let declaration = services.declarations(parameter).first().copied();
                            // A rest parameter takes the rest of the arguments, and none of them is named by it.
                            if declaration.is_some_and(|declaration| services.node_text(declaration).starts_with(b"...")) {
                                break;
                            }
                            let name = services.symbol_info(parameter).name.to_vec();
                            let argument = NodeRef { file, node: argument };
                            let kind = services.node_kind(argument);
                            if name.is_empty()
                                || (names == ParameterNames::Literals && !is_literal(kind))
                                || services.node_text(argument) == name.as_slice()
                            {
                                continue;
                            }
                            let (argument_start, _) = services.node_span(argument);
                            hints.push(Hint {
                                position: positions.of(argument_start).0,
                                label: format!("{}:", String::from_utf8_lossy(&name)),
                                kind: "parameter",
                            });
                        }
                    }
                }
                _ => {}
            }
            work.extend(services.node_children(at).iter().copied());
        }
        hints.retain(|hint| hint.position >= positions.of(from as u32).0 && hint.position <= positions.of(to as u32).0);
        hints.sort_by_key(|hint| hint.position);
        hints
    });
    let mut out = String::from("{\"ok\":true,\"hints\":[");
    for (index, hint) in found.unwrap_or_default().iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&format!("{{\"position\":{},\"kind\":\"{}\",\"label\":", hint.position, hint.kind));
        check::string(&mut out, hint.label.as_bytes());
        out.push('}');
    }
    out.push_str("]}");
    out
}
