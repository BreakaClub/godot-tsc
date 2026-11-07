//! ES module syntax to a function body, over Bun's own AST.
//!
//! Bun's printer prints `import` and `export` statements as they are; Bun's CommonJS output is made by its linker
//! (`bundler/linker_context`), which has no single-file mode. This pass is the single-file conversion, written over the
//! pieces that the parser and printer already have for it:
//!
//! - an import statement becomes `const _m = require("specifier")` (the statement `E::RequireString` prints as `require(...)`),
//!   hoisted to the top as ES imports are, and every use of an imported name becomes a read off `_m` at the time of the
//!   use (`symbol.namespace_alias`, which the printer prints as `_m.name`, `(0, _m.name)(...)` as a callee): live bindings;
//! - an export becomes a getter on `exports` (`Object.defineProperty(exports, "name", { enumerable: true, get: () => name })`),
//!   defined before anything runs, so that a cycle sees what ES modules see (the binding, in its temporal dead zone until it
//!   is initialised);
//! - the statements of React Fast Refresh's runtime import go: `$RefreshReg$` and `$RefreshSig$` are the free identifiers
//!   of the function the host evaluates `code` in.
//!
//! The pass makes no name of its own that could collide with a name in the file: fresh names are checked against every symbol.

use crate::protocol::{Diagnostic, Severity};
use bun_alloc::Arena;
use bun_ast::symbol::{Kind as SymbolKind, Symbol};
use bun_ast::{Ast, B, Binding, E, Expr, G, ImportRecordFlags, Loc, PartTag, Ref, S, Stmt, StmtData, StmtOrExpr, StoreSlice, StoreStr};
use bun_collections::VecExt;
use std::collections::HashSet;

/// What the pass found out about the module, for the response.
pub struct Lowered {
    /// The specifiers of the module's static imports, once each, in the order of the `require` calls.
    pub imports: Vec<String>,
    /// The names the module exports (`default` included), once each, in the order of their getters.
    pub exports: Vec<String>,
}

/// The runtime import that the parser makes for React Fast Refresh; `$RefreshReg$` and `$RefreshSig$` come from the host.
const REFRESH_RUNTIME: &[u8] = b"react-refresh/runtime";
/// The names the parser gives the two refresh functions before a hash is added to them (`P::declare_generated_symbol`).
const REFRESH_REGISTER: &[u8] = b"$RefreshReg$";
const REFRESH_SIGNATURE: &[u8] = b"$RefreshSig$";
/// What the parser calls the temporaries of its lowerings, with a counter (`P::generate_temp_ref`).
const TEMPORARY_PREFIX: &[u8] = b"__bun_temp_ref_";
const TEMPORARY_SUFFIX: u8 = b'$';

/// Names that the pass uses as free identifiers: a module-level binding with one of them would be read in their place.
const FREE_NAMES: &[&[u8]] = &[b"exports", b"module", b"require", b"Object"];

struct Export {
    name: Vec<u8>,
    /// What the getter returns.
    value: Expr,
}

struct Lowerer<'x, 'a> {
    ast: &'x mut Ast<'a>,
    arena: &'x Arena,
    /// Every name of the file's symbols, and those the pass has made.
    names: HashSet<Vec<u8>>,
    source_index: u32,
    requires: Vec<Stmt>,
    exports: Vec<Export>,
    /// `export * from "x"`: the namespace variables whose names are all re-exported.
    star_exports: Vec<Ref>,
    specifiers: Vec<String>,
    object: Option<Ref>,
}

/// The module's statements as a function body. `Err` is a diagnostic: the module cannot be a function body.
pub fn to_function_body(ast: &mut Ast<'_>, arena: &Arena) -> Result<Lowered, Diagnostic> {
    let names = ast.symbols.as_slice().iter().map(|symbol| symbol.original_name.slice().to_vec()).collect();
    let source_index = ast.exports_ref.source_index();
    let mut lowerer = Lowerer {
        ast,
        arena,
        names,
        source_index,
        requires: Vec::new(),
        exports: Vec::new(),
        star_exports: Vec::new(),
        specifiers: Vec::new(),
        object: None,
    };
    lowerer.check_free_names()?;
    lowerer.check_import_meta()?;
    lowerer.name_refresh_functions();
    lowerer.run()
}

fn diagnostic(message: String) -> Diagnostic {
    Diagnostic { start: 0, end: 0, line: 0, character: 0, severity: Severity::Error, message }
}

fn ident(ref_: Ref) -> Expr {
    Expr::init_identifier(ref_, Loc::EMPTY)
}

fn string(bytes: &[u8]) -> Expr {
    Expr::init(E::String::init(bun_ast::data_store_dupe_str(bytes)), Loc::EMPTY)
}

fn dot(target: Expr, name: &'static [u8]) -> Expr {
    Expr::init(E::Dot { target, name: name.into(), name_loc: Loc::EMPTY, ..Default::default() }, Loc::EMPTY)
}

fn call(target: Expr, arguments: &[Expr]) -> Expr {
    Expr::init(E::Call { target, args: bun_ast::ExprNodeList::from_slice(arguments), ..Default::default() }, Loc::EMPTY)
}

fn property(name: &'static [u8], value: Expr) -> G::Property {
    G::Property { key: Some(string(name)), value: Some(value), ..Default::default() }
}

fn object(properties: Vec<G::Property>) -> Expr {
    Expr::init(E::Object { properties: G::PropertyList::move_from_list(properties), ..Default::default() }, Loc::EMPTY)
}

fn boolean(value: bool) -> Expr {
    Expr::init(E::Boolean { value }, Loc::EMPTY)
}

/// `() => value`
fn getter(arena: &Arena, value: Expr) -> Expr {
    let body = G::FnBody::init_return_expr(arena, value).expect("an arena allocation does not fail");
    Expr::init(E::Arrow { body, prefer_expr: true, ..Default::default() }, Loc::EMPTY)
}

/// `target.name`, or `target["name"]` when `name` is no identifier.
fn member(target: Expr, name: &[u8]) -> Expr {
    if bun_js_parser::lexer::is_identifier(name) {
        Expr::init(
            E::Dot { target, name: StoreStr::new(bun_ast::data_store_dupe_str(name)), name_loc: Loc::EMPTY, ..Default::default() },
            Loc::EMPTY,
        )
    } else {
        Expr::init(E::Index { target, index: string(name), optional_chain: None, is_import_property_use: false }, Loc::EMPTY)
    }
}

impl<'x, 'a> Lowerer<'x, 'a> {
    fn symbol_name(&self, ref_: Ref) -> &[u8] {
        self.ast.symbols.as_slice()[ref_.inner_index() as usize].original_name.slice()
    }

    /// The symbol a reference ends at once the links that the parser made between redeclarations are followed.
    fn follow(&self, mut ref_: Ref) -> Ref {
        loop {
            let link = self.ast.symbols.as_slice()[ref_.inner_index() as usize].link.get();
            if !link.is_valid() {
                return ref_;
            }
            ref_ = link;
        }
    }

    /// A symbol that nothing declares, named `base` (or `base` with a number after it if a name of the file is that).
    fn fresh_symbol(&mut self, base: &[u8], kind: SymbolKind) -> Ref {
        let mut name = base.to_vec();
        let mut counter = 1;
        while self.names.contains(&name) {
            counter += 1;
            name = [base, counter.to_string().as_bytes()].concat();
        }
        self.names.insert(name.clone());
        let name = StoreStr::new(self.arena.alloc_slice_copy(&name));
        let inner_index = u32::try_from(self.ast.symbols.len()).expect("a file has fewer than 2^32 symbols");
        self.ast.symbols.push(Symbol { kind, original_name: name, ..Default::default() });
        Ref::init(inner_index, self.source_index, false)
    }

    /// A module-level binding named like a free identifier of the pass would be read in its place.
    fn check_free_names(&self) -> Result<(), Diagnostic> {
        for (name, member) in self.ast.module_scope.members.iter() {
            // `exports`, `module` and `require` are declared by the parser in every file, at no position.
            if member.loc.start >= 0 && FREE_NAMES.contains(&name.as_ref()) {
                let position = member.loc.start as usize;
                return Err(Diagnostic {
                    start: position,
                    end: position + name.len(),
                    ..diagnostic(format!(
                        "the module-level binding `{}` collides with the function body the module is converted to, which reads `{}` as a free identifier",
                        String::from_utf8_lossy(name),
                        String::from_utf8_lossy(name)
                    ))
                });
            }
        }
        Ok(())
    }

    /// `import.meta` is a syntax error in a function body.
    fn check_import_meta(&self) -> Result<(), Diagnostic> {
        if self.ast.has_import_meta {
            return Err(diagnostic(
                "import.meta cannot be used: the module is converted to a function body, in which it is a syntax error".to_string(),
            ));
        }
        Ok(())
    }

    /// The parser gives the refresh functions the hashed names of its generated symbols (`$RefreshReg$_a1b2c3d4`; the hash
    /// keeps them from colliding with the file's names where nothing renames). The host passes them in as `$RefreshReg$` and
    /// `$RefreshSig$`; its temporaries, `__bun_temp_ref_1$`, become `_tmp1`.
    fn name_refresh_functions(&mut self) {
        let generated: Vec<Ref> = self.ast.module_scope.generated.as_slice().to_vec();
        for ref_ in generated {
            let name = self.symbol_name(ref_).to_vec();
            let wanted = if has_hash_suffix(&name, REFRESH_REGISTER) {
                Some(REFRESH_REGISTER.to_vec())
            } else if has_hash_suffix(&name, REFRESH_SIGNATURE) {
                Some(REFRESH_SIGNATURE.to_vec())
            } else {
                None
            };
            if let Some(wanted) = wanted {
                self.rename(ref_, &wanted);
            }
        }
        // Temporaries are in whatever scope made them: all symbols are looked at, by their exact shape.
        for index in 0..self.ast.symbols.len() {
            let name = self.ast.symbols.as_slice()[index].original_name.slice().to_vec();
            if let Some(number) = name.strip_prefix(TEMPORARY_PREFIX).and_then(|rest| rest.strip_suffix(&[TEMPORARY_SUFFIX][..])) {
                if !number.is_empty() && number.iter().all(u8::is_ascii_hexdigit) {
                    let wanted = [b"_tmp".as_slice(), number].concat();
                    let ref_ = Ref::init(u32::try_from(index).expect("a file has fewer than 2^32 symbols"), self.source_index, false);
                    self.rename(ref_, &wanted);
                }
            }
        }
    }

    fn rename(&mut self, ref_: Ref, wanted: &[u8]) {
        let mut name = wanted.to_vec();
        let mut counter = 1;
        while self.names.contains(&name) {
            counter += 1;
            name = [wanted, counter.to_string().as_bytes()].concat();
        }
        self.names.insert(name.clone());
        let name = StoreStr::new(self.arena.alloc_slice_copy(&name));
        self.ast.symbols.as_mut_slice()[ref_.inner_index() as usize].original_name = name;
    }

    fn run(mut self) -> Result<Lowered, Diagnostic> {
        // Every statement of the module, in order, whichever part holds it.
        let mut statements: Vec<(PartTag, Stmt)> = Vec::new();
        for part in self.ast.parts.iter() {
            statements.extend(part.stmts.slice().iter().map(|stmt| (part.tag, *stmt)));
        }

        let mut directives: Vec<Stmt> = Vec::new();
        let mut body: Vec<Stmt> = Vec::new();
        for (tag, stmt) in statements {
            match stmt.data {
                StmtData::SDirective(directive) => {
                    // The function body has its own "use strict" (below); the others keep their place in the prologue.
                    if body.is_empty() && directive.value.slice() != b"use strict" {
                        directives.push(stmt);
                    } else if directive.value.slice() != b"use strict" {
                        body.push(stmt);
                    }
                }
                StmtData::SImport(import) => self.import(tag, stmt, &import)?,
                StmtData::SExportFrom(export) => self.export_from(stmt, &export),
                StmtData::SExportStar(export) => self.export_star(stmt, &export),
                StmtData::SExportClause(clause) => self.export_clause(&clause),
                StmtData::SExportDefault(export) => {
                    if let Some(kept) = self.export_default(stmt, &export) {
                        body.push(kept);
                    }
                }
                StmtData::SExportEquals(equals) => body.push(self.export_equals(stmt, equals.value)),
                StmtData::SLocal(mut local) => {
                    if local.is_export {
                        local.is_export = false;
                        for declaration in local.decls.slice() {
                            self.export_binding(declaration.binding);
                        }
                    }
                    body.push(stmt);
                }
                StmtData::SFunction(mut function) => {
                    if function.func.flags.contains(bun_ast::flags::Function::IsExport) {
                        function.func.flags.remove(bun_ast::flags::Function::IsExport);
                        if let Some(name) = function.func.name {
                            self.export_ref(name.ref_, None);
                        }
                    }
                    body.push(stmt);
                }
                StmtData::SClass(mut class) => {
                    if class.is_export {
                        class.is_export = false;
                        if let Some(name) = class.class.class_name {
                            self.export_ref(name.ref_, None);
                        }
                    }
                    body.push(stmt);
                }
                _ => body.push(stmt),
            }
        }

        let mut out: Vec<Stmt> = Vec::new();
        out.push(Stmt::alloc(S::Directive { value: StoreStr::new(b"use strict") }, Loc::EMPTY));
        out.extend(directives);
        out.extend(self.export_statements());
        out.extend(std::mem::take(&mut self.requires));
        out.extend(self.star_export_statements());
        out.extend(body);

        let stmts = StoreSlice::new_mut(self.arena.alloc_slice_copy(&out));
        let mut parts = self.ast.parts.iter_mut();
        let first = parts.next().expect("a parsed file has a part");
        first.stmts = stmts;
        for part in parts {
            part.stmts = StoreSlice::EMPTY;
        }

        let mut exports: Vec<String> = Vec::new();
        for export in &self.exports {
            let name = String::from_utf8_lossy(&export.name).into_owned();
            if !exports.contains(&name) {
                exports.push(name);
            }
        }
        Ok(Lowered { imports: self.specifiers, exports })
    }

    // ───────────────────────────── imports ─────────────────────────────

    fn record_specifier(&mut self, import_record_index: u32) -> String {
        let record = &self.ast.import_records.as_slice()[import_record_index as usize];
        let specifier = String::from_utf8_lossy(record.path.text).into_owned();
        if !self.specifiers.contains(&specifier) {
            self.specifiers.push(specifier.clone());
        }
        specifier
    }

    /// A name for the variable that holds a module's exports: the specifier as an identifier, after a `_`.
    fn namespace_base(specifier: &str) -> Vec<u8> {
        let trimmed = specifier.trim_start_matches(|c: char| c == '.' || c == '/' || c == '@');
        let mut name = String::from("_");
        let mut previous_underscore = true;
        for c in trimmed.chars() {
            if c.is_ascii_alphanumeric() {
                name.push(c);
                previous_underscore = false;
            } else if !previous_underscore {
                name.push('_');
                previous_underscore = true;
            }
        }
        while name.ends_with('_') && name.len() > 1 {
            name.pop();
        }
        name.into_bytes()
    }

    /// `const namespace = require("specifier")`.
    fn require_statement(&mut self, namespace: Ref, import_record_index: u32, loc: Loc) -> Stmt {
        let value = Expr::init(E::RequireString { import_record_index, ..Default::default() }, loc);
        Stmt::alloc(
            S::Local {
                kind: S::Kind::KConst,
                decls: G::DeclList::from_slice(&[G::Decl {
                    binding: Binding::alloc(self.arena, B::Identifier { r#ref: namespace }, loc),
                    value: Some(value),
                }]),
                ..Default::default()
            },
            loc,
        )
    }

    /// Reads of `symbol` print as `namespace.alias`.
    fn alias(&mut self, symbol: Ref, namespace: Ref, alias: StoreStr, import_record_index: u32) {
        let symbol = self.follow(symbol);
        self.ast.symbols.as_mut_slice()[symbol.inner_index() as usize].namespace_alias = Some(bun_alloc::ast_box(G::NamespaceAlias {
            namespace_ref: namespace,
            alias,
            was_originally_property_access: false,
            import_record_index,
        }));
    }

    fn import(&mut self, tag: PartTag, stmt: Stmt, import: &S::Import) -> Result<(), Diagnostic> {
        let loc = stmt.loc;
        let record_index = import.import_record_index;
        let record = &self.ast.import_records.as_slice()[record_index as usize];
        if record.path.text == REFRESH_RUNTIME && tag == PartTag::Runtime {
            // The parser's own import of the refresh functions: they are the host's.
            self.ast.import_records.as_mut_slice()[record_index as usize].flags.insert(ImportRecordFlags::IS_UNUSED);
            return Ok(());
        }
        let specifier = self.record_specifier(record_index);
        let has_bindings = import.default_name.is_some() || !import.items.is_empty() || !import.star_name_loc.is_empty();
        if !has_bindings {
            let call = Expr::init(E::RequireString { import_record_index: record_index, ..Default::default() }, loc);
            self.requires.push(Stmt::alloc(S::SExpr { value: call, does_not_affect_tree_shaking: false }, loc));
            return Ok(());
        }
        // `import * as ns` has the file's own name for the namespace; the others have the parser's, which two imports of
        // files of the same name share (`import_index`): each gets a name of its own.
        let namespace = if import.star_name_loc.is_empty() {
            let base = Self::namespace_base(&specifier);
            self.fresh_symbol(&base, SymbolKind::Other)
        } else {
            import.namespace_ref
        };
        let require = self.require_statement(namespace, record_index, loc);
        self.requires.push(require);
        if let Some(default) = import.default_name {
            self.alias(default.ref_, namespace, StoreStr::new(b"default"), record_index);
        }
        for item in import.items.slice() {
            self.alias(item.name.ref_, namespace, item.alias, record_index);
        }
        Ok(())
    }

    // ───────────────────────────── exports ─────────────────────────────

    fn add_export(&mut self, name: &[u8], value: Expr) {
        self.exports.push(Export { name: name.to_vec(), value });
    }

    /// Exports the binding `ref_` under `alias`, or under its own name.
    fn export_ref(&mut self, ref_: Ref, alias: Option<StoreStr>) {
        let name = alias.map_or_else(|| self.symbol_name(ref_).to_vec(), |alias| alias.slice().to_vec());
        let target = self.follow(ref_);
        let is_import = self.ast.symbols.as_slice()[target.inner_index() as usize].kind == SymbolKind::Import;
        // A name that was imported is read through its namespace, so that the export follows the import.
        let value = if is_import { Expr::init(E::ImportIdentifier::new(ref_, true), Loc::EMPTY) } else { ident(ref_) };
        self.add_export(&name, value);
    }

    fn export_binding(&mut self, binding: Binding) {
        match binding.data {
            B::B::BMissing(_) => {}
            B::B::BIdentifier(identifier) => self.export_ref(identifier.r#ref, None),
            B::B::BArray(array) => {
                for item in array.items.iter() {
                    self.export_binding(item.binding);
                }
            }
            B::B::BObject(object) => {
                for property in object.properties.iter() {
                    self.export_binding(property.value);
                }
            }
        }
    }

    fn export_clause(&mut self, clause: &S::ExportClause) {
        for item in clause.items.slice() {
            self.export_ref(item.name.ref_, Some(item.alias));
        }
    }

    fn export_from(&mut self, stmt: Stmt, export: &S::ExportFrom) {
        let specifier = self.record_specifier(export.import_record_index);
        let namespace = self.fresh_symbol(&Self::namespace_base(&specifier), SymbolKind::Other);
        let require = self.require_statement(namespace, export.import_record_index, stmt.loc);
        self.requires.push(require);
        for item in export.items.slice() {
            // `export { a as b } from "x"`: `item.original_name` is `a`, the name in "x"; `item.alias` is `b`.
            self.add_export(item.alias.slice(), member(ident(namespace), item.original_name.slice()));
        }
    }

    fn export_star(&mut self, stmt: Stmt, export: &S::ExportStar) {
        let specifier = self.record_specifier(export.import_record_index);
        let namespace = self.fresh_symbol(&Self::namespace_base(&specifier), SymbolKind::Other);
        let require = self.require_statement(namespace, export.import_record_index, stmt.loc);
        self.requires.push(require);
        match &export.alias {
            // `export * as ns from "x"`
            Some(alias) => self.add_export(alias.original_name.slice(), ident(namespace)),
            None => self.star_exports.push(namespace),
        }
    }

    /// `export default`: what is declared stays, and the default export is a getter on its name. An expression gets a
    /// variable of the parser's making (`<file>_default`).
    fn export_default(&mut self, stmt: Stmt, export: &S::ExportDefault) -> Option<Stmt> {
        let loc = stmt.loc;
        match &export.value {
            StmtOrExpr::Stmt(declaration) => {
                let name = match declaration.data {
                    StmtData::SFunction(function) => function.func.name.map(|name| name.ref_),
                    StmtData::SClass(mut class) => Some(class.class.class_name.get_or_insert(export.default_name).ref_),
                    _ => None,
                };
                if let Some(name) = name {
                    self.add_export(b"default", ident(name));
                }
                Some(*declaration)
            }
            StmtOrExpr::Expr(value) => {
                // A variable of a name of the pass's own: the parser names the default export after the function or class it
                // wraps, and a variable of that name besides the binding already there (`const Name = signature(function
                // Name() {})`, which React Fast Refresh makes of `export default function Name`) would declare it twice.
                let name = self.fresh_symbol(b"_default", SymbolKind::Other);
                self.add_export(b"default", ident(name));
                Some(Stmt::alloc(
                    S::Local {
                        kind: S::Kind::KConst,
                        decls: G::DeclList::from_slice(&[G::Decl {
                            binding: Binding::alloc(self.arena, B::Identifier { r#ref: name }, loc),
                            value: Some(*value),
                        }]),
                        ..Default::default()
                    },
                    loc,
                ))
            }
        }
    }

    /// TypeScript's `export = value`.
    fn export_equals(&mut self, stmt: Stmt, value: Expr) -> Stmt {
        let target = dot(ident(self.ast.module_ref), b"exports");
        Stmt::alloc(S::SExpr { value: Expr::assign(target, value), does_not_affect_tree_shaking: false }, stmt.loc)
    }

    fn object_ref(&mut self) -> Ref {
        if let Some(object) = self.object {
            return object;
        }
        // The global `Object`: a symbol nothing declares, which prints as its name.
        let object = self.fresh_symbol(b"Object", SymbolKind::Unbound);
        self.object = Some(object);
        object
    }

    fn define_property(&mut self, name: Expr, descriptor: Expr) -> Stmt {
        let target = dot(ident(self.object_ref()), b"defineProperty");
        let value = call(target, &[ident(self.ast.exports_ref), name, descriptor]);
        Stmt::alloc(S::SExpr { value, does_not_affect_tree_shaking: false }, Loc::EMPTY)
    }

    /// `Object.defineProperty(exports, "__esModule", { value: true })` and a getter for each export.
    fn export_statements(&mut self) -> Vec<Stmt> {
        let mut statements = Vec::new();
        if self.exports.is_empty() && self.star_exports.is_empty() {
            return statements;
        }
        statements.push(self.define_property(string(b"__esModule"), object(vec![property(b"value", boolean(true))])));
        // The last export of a name wins, as a duplicate would be a syntax error in the file and is one of the
        // parser's own (re-exports of one name by `export *` and a declaration) otherwise.
        let exports = std::mem::take(&mut self.exports);
        for export in &exports {
            let descriptor = object(vec![property(b"enumerable", boolean(true)), property(b"get", getter(self.arena, export.value))]);
            statements.push(self.define_property(string(&export.name), descriptor));
        }
        self.exports = exports;
        statements
    }

    /// `export * from "x"`: what "x" exports, but `default`, as getters, unless the module has an export of that name.
    ///
    /// ```js
    /// for (const key in ns) if (key !== "default" && key !== "__esModule" && !Object.prototype.hasOwnProperty.call(exports, key))
    ///   Object.defineProperty(exports, key, { enumerable: true, get: () => ns[key] });
    /// ```
    fn star_export_statements(&mut self) -> Vec<Stmt> {
        let namespaces = std::mem::take(&mut self.star_exports);
        let mut statements = Vec::new();
        for namespace in namespaces {
            let key = self.fresh_symbol(b"key", SymbolKind::Other);
            let key_binding = Binding::alloc(self.arena, B::Identifier { r#ref: key }, Loc::EMPTY);
            let not_equal =
                |name: &[u8]| Expr::init(E::Binary { op: bun_ast::OpCode::BinStrictNe, left: ident(key), right: string(name) }, Loc::EMPTY);
            let has_own = call(
                dot(dot(dot(ident(self.object_ref()), b"prototype"), b"hasOwnProperty"), b"call"),
                &[ident(self.ast.exports_ref), ident(key)],
            );
            let absent = Expr::init(E::Unary { op: bun_ast::OpCode::UnNot, value: has_own, flags: Default::default() }, Loc::EMPTY);
            let condition = [not_equal(b"default"), not_equal(b"__esModule"), absent]
                .into_iter()
                .reduce(|left, right| Expr::init(E::Binary { op: bun_ast::OpCode::BinLogicalAnd, left, right }, Loc::EMPTY))
                .expect("three conditions");
            let read = Expr::init(
                E::Index { target: ident(namespace), index: ident(key), optional_chain: None, is_import_property_use: false },
                Loc::EMPTY,
            );
            let descriptor = object(vec![property(b"enumerable", boolean(true)), property(b"get", getter(self.arena, read))]);
            let define = self.define_property(ident(key), descriptor);
            let guarded = Stmt::alloc(S::If { test: condition, yes: define, no: None }, Loc::EMPTY);
            statements.push(Stmt::alloc(
                S::ForIn {
                    init: Stmt::alloc(
                        S::Local {
                            kind: S::Kind::KConst,
                            decls: G::DeclList::from_slice(&[G::Decl { binding: key_binding, value: None }]),
                            ..Default::default()
                        },
                        Loc::EMPTY,
                    ),
                    value: ident(namespace),
                    body: guarded,
                },
                Loc::EMPTY,
            ));
        }
        statements
    }
}

/// `name` followed by `_` and the hash of 8 lowercase letters or digits that `P::hash_generated_name` adds.
fn has_hash_suffix(symbol: &[u8], name: &[u8]) -> bool {
    symbol
        .strip_prefix(name)
        .and_then(|rest| rest.strip_prefix(b"_"))
        .is_some_and(|hash| !hash.is_empty() && hash.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}
