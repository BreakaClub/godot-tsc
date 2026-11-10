//! Navigation and renaming: where a name is defined, every place it is referenced, and the edits that rename it. What TypeScript's
//! language service does for `getDefinitionAtPosition`, `findReferences` and `findRenameLocations`, over the services of `bun_sema`.
//!
//! A symbol is known by its declarations (the files and nodes that declare it), with an import followed to what it imports: the
//! services number symbols afresh for each file, and the declarations are what stays the same from one file's services to the next.
//! References are found by visiting every name of every file of the project but the lib files and asking each what it refers to.
//!
//! Positions are LSP's: a line and a character in UTF-16 code units, both from 0.

use crate::check::{MemoryHost, Positions, ProgramView, Runs, with_program};
use bun_sema::check::services::{Child, Location, NodeRef, Row, Services, SymbolFlags, SymbolOp, SymbolRef};
use bun_sema::node::{Kind, Node};
use bun_sema::program::FileId;

/// A place in a file: its path, and the start and end as `(line, character)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Place {
    pub path: String,
    pub start: (usize, usize),
    pub end: (usize, usize),
}

/// A name that refers to the symbol asked about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Occurrence {
    pub place: Place,
    /// The name is the one a declaration of the symbol declares.
    pub is_declaration: bool,
    /// What a rename writes here: the new name alone, or, for a shorthand property (`{ x }`) or a shorthand binding (`const { x } = o`)
    /// where only one of the property and the variable is renamed, both.
    pub shorthand: Shorthand,
    /// The name as it is written here: an import that renames (`import { a as b }`) is referred to by another name.
    pub name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shorthand {
    /// Not a shorthand: the name is replaced.
    No,
    /// The variable is renamed and the property keeps the name: `x` becomes `x: renamed`.
    KeepProperty,
    /// The property is renamed and the variable keeps the name: `x` becomes `renamed: x`.
    KeepVariable,
}

/// What the person asked about: a file of the project and a position in it.
pub struct At<'a> {
    pub config: &'a [u8],
    pub lib_dir: &'a [u8],
    pub path: &'a [u8],
    pub line: usize,
    pub character: usize,
}

/// A symbol as it is known across files: its declarations, sorted.
#[derive(Clone, PartialEq, Eq)]
struct Identity(Vec<(u32, u32)>);

impl Identity {
    fn declares(&self, declaration: NodeRef) -> bool {
        self.0.binary_search(&(declaration.file.0, declaration.node.0)).is_ok()
    }
}

fn is_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$' || byte == b'#' || byte >= 0x80
}

/// The name node at a position: in the name, or just after its end (where a caret is after typing it).
fn name_at(services: &mut Services<'_, '_, '_>, file: FileId, text: &[u8], line: usize, character: usize) -> Option<NodeRef> {
    let mut byte = Positions::new(text).byte_at(line, character);
    let inside = |at: usize| text.get(at).is_some_and(|&b| is_name_byte(b));
    if !inside(byte) && byte > 0 && inside(byte - 1) {
        byte -= 1;
    }
    if !inside(byte) {
        return None;
    }
    while byte > 0 && inside(byte - 1) {
        byte -= 1;
    }
    let node = services.node(Location { row: Row::NameAt(byte as u32), part: None });
    let at = NodeRef { file, node };
    match node.is_some() && matches!(services.node_kind(at), Kind::Identifier | Kind::PrivateIdentifier) {
        true => Some(at),
        false => None,
    }
}

/// The symbol an import or an export of a name stands for, or the symbol itself.
fn target(services: &mut Services<'_, '_, '_>, symbol: SymbolRef) -> SymbolRef {
    if !services.symbol_info(symbol).flags.contains(SymbolFlags::ALIAS) {
        return symbol;
    }
    match services.symbol_op(SymbolOp::Aliased, symbol) {
        Some(aliased) if !services.is_unknown_symbol(aliased) => aliased,
        _ => symbol,
    }
}

fn identity_of(services: &mut Services<'_, '_, '_>, symbol: SymbolRef) -> Option<Identity> {
    let symbol = target(services, symbol);
    let mut declarations: Vec<(u32, u32)> = services.declarations(symbol).iter().map(|d| (d.file.0, d.node.0)).collect();
    if declarations.is_empty() {
        return None;
    }
    declarations.sort_unstable();
    declarations.dedup();
    Some(Identity(declarations))
}

fn place(services: &mut Services<'_, '_, '_>, path: &[u8], text: &[u8], node: NodeRef) -> Place {
    let (start, end) = services.node_span(node);
    let positions = Positions::new(text);
    let (_, start_line, start_character) = positions.of(start);
    let (_, end_line, end_character) = positions.of(end);
    Place { path: String::from_utf8_lossy(path).into_owned(), start: (start_line, start_character), end: (end_line, end_character) }
}

/// The property named `name` of the type that the object literal around `assignment` is checked against (`const p: Point = { x: 0 }`:
/// `Point`'s `x`). The checker's symbol for the name is the literal's own property; TypeScript's references follow the contextual type.
fn contextual_property(services: &mut Services<'_, '_, '_>, assignment: NodeRef, name: NodeRef) -> Option<SymbolRef> {
    let literal = NodeRef { file: assignment.file, node: services.node_parent(assignment) };
    let ty = services.contextual_type(literal)?;
    let text = services.node_text(name).to_vec();
    services.property_of_type(ty, &text)
}

/// The symbols a name refers to, each with what renaming it does there, the one that definitions go to first. A shorthand property or
/// binding refers to two: the property and the variable.
fn referred(services: &mut Services<'_, '_, '_>, name: NodeRef) -> Vec<(SymbolRef, Shorthand)> {
    let parent = NodeRef { file: name.file, node: services.node_parent(name) };
    let mut found = Vec::new();
    match services.node_kind(parent) {
        // `{ x: 1 }`: the property of the type the literal is for, and the literal's own.
        Kind::PropertyAssignment if services.node_child(parent, Child::Name) == name.node => {
            if let Some(property) = contextual_property(services, parent, name) {
                found.push((property, Shorthand::No));
            }
            if let Some(own) = services.symbol_at_location(name) {
                found.push((own, Shorthand::No));
            }
        }
        // `{ x }`: the name is the property's (the contextual type's, and the literal's own), and the value is the variable.
        Kind::ShorthandPropertyAssignment => {
            if let Some(property) = contextual_property(services, parent, name) {
                found.push((property, Shorthand::KeepVariable));
            }
            if let Some(property) = services.symbol_at_location(name) {
                found.push((property, Shorthand::KeepVariable));
            }
            if let Some(variable) = services.shorthand_assignment_value_symbol(parent) {
                found.push((variable, Shorthand::KeepProperty));
            }
        }
        // `const { x } = o`: the name declares the variable, and is the property of what is destructured.
        Kind::BindingElement if services.node_child(parent, Child::PropertyName).is_none() => {
            let pattern = NodeRef { file: name.file, node: services.node_parent(parent) };
            if let Some(variable) = services.symbol_at_location(name) {
                found.push((variable, Shorthand::KeepProperty));
            }
            if services.node_kind(pattern) == Kind::ObjectBindingPattern {
                let destructured = services.type_at_location(pattern);
                let text = services.node_text(name).to_vec();
                if let Some(property) = services.property_of_type(destructured, &text) {
                    found.push((property, Shorthand::KeepVariable));
                }
            }
        }
        _ => {
            if let Some(symbol) = services.symbol_at_location(name) {
                found.push((symbol, Shorthand::No));
            }
        }
    }
    found
}

/// The identity of what the name at `at` refers to (the variable, for a shorthand), and the name's node.
fn identity_at(view: &mut ProgramView<'_, '_>, at: &At<'_>) -> Option<(Identity, NodeRef)> {
    let file = view.file(at.path)?;
    view.with_services(file, |services, file, text| {
        let name = name_at(services, file, text, at.line, at.character)?;
        let (symbol, _) = referred(services, name).into_iter().find(|&(_, shorthand)| shorthand != Shorthand::KeepVariable)?;
        Some((identity_of(services, symbol)?, name))
    })
}

/// The names in `file` that refer to `identity`.
fn occurrences_in(view: &mut ProgramView<'_, '_>, file: FileId, identity: &Identity) -> Vec<Occurrence> {
    let path = view.path(file);
    view.with_services(file, |services, file, text| {
        let mut found = Vec::new();
        let mut work = vec![Node::FILE];
        while let Some(node) = work.pop() {
            let at = NodeRef { file, node };
            if matches!(services.node_kind(at), Kind::Identifier | Kind::PrivateIdentifier) {
                for (symbol, shorthand) in referred(services, at) {
                    if identity_of(services, symbol).as_ref() != Some(identity) {
                        continue;
                    }
                    let parent = NodeRef { file, node: services.node_parent(at) };
                    let is_declaration = identity.declares(parent) && services.node_child(parent, Child::Name) == node;
                    let name = String::from_utf8_lossy(services.node_text(at)).into_owned();
                    found.push(Occurrence { place: place(services, path, text, at), is_declaration, shorthand, name });
                    break;
                }
            }
            work.extend(services.node_children(at).iter().copied());
        }
        // In the order of the text, as an editor lists them.
        found.sort_by_key(|occurrence| occurrence.place.start);
        found
    })
}

/// Where the name at `at` is defined: the names of its declarations, an import followed to what it imports. Declarations in the lib
/// files are left out (the checker keeps no text of them, so they have no position).
pub fn definitions(host: &MemoryHost, runs: &mut Runs, at: &At<'_>) -> Vec<Place> {
    with_program(host, runs, at.config, at.lib_dir, |view| {
        let Some((identity, _)) = identity_at(view, at) else {
            return Vec::new();
        };
        declaration_names(view, &identity)
    })
}

/// Where the type of the name at `at` is defined.
pub fn type_definitions(host: &MemoryHost, runs: &mut Runs, at: &At<'_>) -> Vec<Place> {
    with_program(host, runs, at.config, at.lib_dir, |view| {
        let Some(file) = view.file(at.path) else {
            return Vec::new();
        };
        let found = view.with_services(file, |services, file, text| {
            let name = name_at(services, file, text, at.line, at.character)?;
            let ty = services.type_at_location(name);
            let symbol = services.symbol_of_type(ty)?;
            identity_of(services, symbol)
        });
        match found {
            Some(identity) => declaration_names(view, &identity),
            None => Vec::new(),
        }
    })
}

/// The name of each declaration of `identity` (the declaration itself if it has none), in the project's files.
fn declaration_names(view: &mut ProgramView<'_, '_>, identity: &Identity) -> Vec<Place> {
    let mut places = Vec::new();
    for &(file, node) in &identity.0 {
        let file = FileId(file);
        if view.is_lib(file) {
            continue;
        }
        let path = view.path(file);
        let declared = view.with_services(file, |services, file, text| {
            let declaration = NodeRef { file, node: Node(node) };
            let name = services.node_child(declaration, Child::Name);
            let shown = match name.is_some() {
                true => NodeRef { file, node: name },
                false => declaration,
            };
            place(services, path, text, shown)
        });
        places.push(declared);
    }
    places
}

/// Every name in the project that refers to what the name at `at` refers to, the declarations' names among them.
pub fn references(host: &MemoryHost, runs: &mut Runs, at: &At<'_>) -> Vec<Occurrence> {
    with_program(host, runs, at.config, at.lib_dir, |view| {
        let Some((identity, _)) = identity_at(view, at) else {
            return Vec::new();
        };
        let mut found = Vec::new();
        for file in view.project_files() {
            found.extend(occurrences_in(view, file, &identity));
        }
        found
    })
}

/// The names in the file at `at` that refer to what the name at `at` refers to (an editor highlights them).
pub fn highlights(host: &MemoryHost, runs: &mut Runs, at: &At<'_>) -> Vec<Occurrence> {
    with_program(host, runs, at.config, at.lib_dir, |view| {
        let Some((identity, name)) = identity_at(view, at) else {
            return Vec::new();
        };
        occurrences_in(view, name.file, &identity)
    })
}

/// Why a name cannot be renamed, as an editor shows it.
#[derive(Debug, PartialEq, Eq)]
pub struct CannotRename(pub String);

/// The name at `at`, if it can be renamed: what it refers to is declared only in the project's files, not in the lib files.
pub fn prepare_rename(host: &MemoryHost, runs: &mut Runs, at: &At<'_>) -> Result<(Place, String), CannotRename> {
    with_program(host, runs, at.config, at.lib_dir, |view| prepare(view, at))
}

fn prepare(view: &mut ProgramView<'_, '_>, at: &At<'_>) -> Result<(Place, String), CannotRename> {
    let Some((identity, name)) = identity_at(view, at) else {
        return Err(CannotRename("You cannot rename this element.".to_string()));
    };
    if identity.0.iter().any(|&(file, _)| view.is_lib(FileId(file))) {
        return Err(CannotRename("You cannot rename elements that are defined in the standard TypeScript library.".to_string()));
    }
    let path = view.path(name.file);
    Ok(view.with_services(name.file, |services, _, text| {
        (place(services, path, text, name), String::from_utf8_lossy(services.node_text(name)).into_owned())
    }))
}

/// The edits that rename what the name at `at` refers to: one per name that refers to it, a shorthand written out in full. A name
/// spelled otherwise is another name for it (`dist` after `import { distance as dist }`) and stays: as in TypeScript, the import's
/// `distance` is renamed and `dist` is not.
pub fn rename(host: &MemoryHost, runs: &mut Runs, at: &At<'_>, new_name: &str) -> Result<Vec<(Place, String)>, CannotRename> {
    if !is_identifier(new_name) {
        return Err(CannotRename(format!("'{new_name}' is not a valid name.")));
    }
    with_program(host, runs, at.config, at.lib_dir, |view| {
        let (_, old_name) = prepare(view, at)?;
        let Some((identity, _)) = identity_at(view, at) else {
            return Err(CannotRename("You cannot rename this element.".to_string()));
        };
        let mut edits = Vec::new();
        for file in view.project_files() {
            for occurrence in occurrences_in(view, file, &identity) {
                if occurrence.name != old_name {
                    continue;
                }
                let written = match occurrence.shorthand {
                    Shorthand::No => new_name.to_string(),
                    Shorthand::KeepProperty => format!("{old_name}: {new_name}"),
                    Shorthand::KeepVariable => format!("{new_name}: {old_name}"),
                };
                edits.push((occurrence.place, written));
            }
        }
        Ok(edits)
    })
}

/// TypeScript's reserved words: a name that is one of them cannot declare a variable.
const RESERVED: &[&str] = &[
    "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export", "extends",
    "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw",
    "true", "try", "typeof", "var", "void", "while", "with",
];

/// Whether `name` is an identifier that is not a reserved word (a private name, `#x`, counts).
fn is_identifier(name: &str) -> bool {
    let plain = name.strip_prefix('#').unwrap_or(name);
    let mut chars = plain.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    let starts = first == '_' || first == '$' || first.is_alphabetic();
    starts && chars.all(|c| c == '_' || c == '$' || c.is_alphanumeric()) && !RESERVED.contains(&plain)
}
