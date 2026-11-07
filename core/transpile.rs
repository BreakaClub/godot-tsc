//! One `transpile` request: parse with Bun's parser, print with Bun's printer.

use crate::positions::position;
use crate::protocol::{Diagnostic, Failed, Response, Severity, Transpiled, TranspileRequest};
use bun_alloc::Arena;
use bun_ast::{ASTMemoryAllocator, Loader, Log, Source};
use bun_js_parser::{Define, Parser, ParserOptions};
use bun_options_types::jsx;

/// The loader for a path, from its extension. `None`: not a JavaScript or TypeScript file.
fn loader_for(path: &str) -> Option<Loader> {
    let extension = path.rsplit_once('.')?.1;
    Some(match extension {
        "tsx" => Loader::Tsx,
        "ts" | "mts" | "cts" => Loader::Ts,
        "jsx" => Loader::Jsx,
        "js" | "mjs" | "cjs" => Loader::Js,
        _ => return None,
    })
}

fn failure(request: &TranspileRequest, log: &Log, extra: Vec<Diagnostic>) -> Response {
    let mut diagnostics = diagnostics_of(request, log);
    diagnostics.extend(extra);
    Response::Failed(Failed { ok: false, diagnostics })
}

fn message(request: &TranspileRequest, message: String) -> Response {
    let _ = request;
    Response::Failed(Failed {
        ok: false,
        diagnostics: vec![Diagnostic { start: 0, end: 0, line: 0, character: 0, severity: Severity::Error, message }],
    })
}

/// The errors and warnings in `log`, with UTF-16 positions in `request.source`.
fn diagnostics_of(request: &TranspileRequest, log: &Log) -> Vec<Diagnostic> {
    log.msgs
        .iter()
        .filter_map(|msg| {
            let severity = match msg.kind {
                bun_ast::Kind::Err => Severity::Error,
                bun_ast::Kind::Warn => Severity::Warning,
                bun_ast::Kind::Note | bun_ast::Kind::Debug | bun_ast::Kind::Verbose => return None,
            };
            let text = String::from_utf8_lossy(&msg.data.text).into_owned();
            // A location with no line has no position either (the parser's "somewhere in the file").
            let (from, to) = match &msg.data.location {
                Some(location) if location.line > 0 => (location.offset, location.offset + location.length),
                _ => (0, 0),
            };
            let start = position(&request.source, from);
            let end = position(&request.source, to);
            Some(Diagnostic { start: start.offset, end: end.offset, line: start.line, character: start.character, severity, message: text })
        })
        .collect()
}

pub fn transpile(request: &TranspileRequest) -> Response {
    let Some(loader) = loader_for(&request.path) else {
        return message(request, format!("cannot transpile {}: the extension is none of .tsx .ts .jsx .js", request.path));
    };

    let arena = Arena::new();
    let mut ast_memory = ASTMemoryAllocator::borrowing(&arena);
    let _scope = ast_memory.enter();

    let mut log = Log::init();
    let source = Source::init_path_string(request.path.as_str(), request.source.as_str());
    let define = Define::default();

    let mut pragma = jsx::Pragma::default();
    // The production calls: `jsx` and `jsxs` from `react/jsx-runtime`, not `jsxDEV` with `__source`.
    pragma.development = false;
    let mut options = ParserOptions::init(pragma, loader);
    options.features.allow_runtime = false;
    options.features.auto_import_jsx = true;
    options.features.no_macros = true;
    options.features.lower_using = false;
    options.features.top_level_await = false;
    options.features.trim_unused_imports = loader.is_typescript() && !request.preserve_unused_imports;
    options.features.standard_decorators = !loader.is_typescript();
    options.features.react_fast_refresh = request.refresh && loader.is_jsx();
    options.preserve_unused_imports_ts = request.preserve_unused_imports;
    options.transform_only = true;

    let parser = match Parser::init(options, &mut log, &source, &define, &arena) {
        Ok(parser) => parser,
        Err(error) => return failure(request, &log, vec![internal(&format!("parser: {error:?}"))]),
    };
    let result = match parser.parse() {
        Ok(result) => result,
        Err(error) => {
            // A syntax error is already in the log; anything else is not.
            let extra = if log.errors == 0 { vec![internal(&format!("parser: {error:?}"))] } else { Vec::new() };
            return failure(request, &log, extra);
        }
    };
    if log.errors > 0 {
        return failure(request, &log, Vec::new());
    }
    let bun_js_parser::Result::Ast(mut ast) = result else {
        return message(request, "the parser did not produce an AST".to_string());
    };
    let lowered = match crate::lower::to_function_body(&mut ast, &arena) {
        Ok(lowered) => lowered,
        Err(diagnostic) => return failure(request, &log, vec![diagnostic]),
    };

    let allocator = *ast.symbols.allocator();
    let symbols = bun_ast::symbol::Map::init_with_one_list(
        core::mem::replace(&mut ast.symbols, bun_alloc::ArenaVec::new_in(allocator)).into_iter().collect(),
    );
    let mut writer = bun_js_printer::BufferPrinter::init(bun_js_printer::BufferWriter::init());
    let options = bun_js_printer::Options {
        bundling: false,
        require_ref: None,
        print_dce_annotations: false,
        inline_require_and_import_errors: false,
        ..Default::default()
    };
    if let Err(error) = bun_js_printer::print_ast::<_, false, false>(&mut writer, &arena, &ast, symbols, &source, options) {
        return failure(request, &log, vec![internal(&format!("printer: {error:?}"))]);
    }
    let code = String::from_utf8_lossy(writer.ctx.get_written()).into_owned();
    Response::Transpiled(Transpiled {
        ok: true,
        code,
        imports: lowered.imports,
        exports: lowered.exports,
        diagnostics: diagnostics_of(request, &log),
        map: None,
    })
}

fn internal(text: &str) -> Diagnostic {
    Diagnostic { start: 0, end: 0, line: 0, character: 0, severity: Severity::Error, message: text.to_string() }
}
