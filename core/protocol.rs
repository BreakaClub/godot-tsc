//! The JSON protocol of `handle`: one request, one response, the same on every front end (a GDExtension, a native
//! process, a WebAssembly module).

use serde::{Deserialize, Serialize};

/// What `ping` reports about the build: the Bun revision the parser and the printer come from.
pub const BUN_REVISION: &str = "408c9374b266b45fe6b8260e09be73aa82a957cd";
pub const NAME: &str = "godot-tsc";

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    Ping,
    Transpile(TranspileRequest),
    /// Adds the file at `path` (absolute, in the checker's format: `/project/lab.tsx`) or replaces its text.
    SetFile(FileText),
    /// Several files at once (opening a project).
    SetFiles {
        files: Vec<FileText>,
    },
    /// Removes the file at `path`, which must be there.
    RemoveFile {
        path: String,
    },
    /// Checks the project whose configuration file is at `config`, with the lib files in `lib_dir`.
    Check {
        config: String,
        lib_dir: String,
    },
    /// What is under `offset` (UTF-16) in the file at `path`: the name and the type (`services::hover`).
    Hover {
        config: String,
        lib_dir: String,
        path: String,
        offset: usize,
    },
    /// The inlay hints between UTF-16 offsets `from` and `to` of the file at `path` (`services::inlay_hints`).
    InlayHints {
        config: String,
        lib_dir: String,
        path: String,
        from: usize,
        to: usize,
        #[serde(default = "default_parameter_names")]
        parameter_names: crate::services::ParameterNames,
    },
}

/// A file of the checker's project: an absolute path and the text.
#[derive(Deserialize)]
pub struct FileText {
    pub path: String,
    pub text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranspileRequest {
    /// Decides the loader by its extension: `.tsx`, `.ts`, `.jsx` or `.js`.
    pub path: String,
    pub source: String,
    /// Instrument the components for React Fast Refresh (`$RefreshReg$`, `$RefreshSig$`). Only JSX files have components:
    /// Bun's own rule (`bundler/ParseTask.rs`: `react_fast_refresh && loader.is_jsx()`).
    #[serde(default)]
    pub refresh: bool,
    /// Return an inline-able source map as `map` (a JSON string).
    #[serde(default)]
    pub source_map: bool,
    /// Keep the imports that nothing uses. TypeScript's own rule, and Bun's, drops them (they may be types); this keeps
    /// them, as `verbatimModuleSyntax` does.
    #[serde(default)]
    pub preserve_unused_imports: bool,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum Response {
    Pong(Pong),
    Done(Done),
    Transpiled(Transpiled),
    Failed(Failed),
}

/// The answer to a request that has nothing to report but that it was done.
#[derive(Serialize)]
pub struct Done {
    pub ok: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pong {
    pub ok: bool,
    pub name: &'static str,
    pub bun_revision: &'static str,
}

#[derive(Serialize)]
pub struct Transpiled {
    pub ok: bool,
    pub code: String,
    pub imports: Vec<String>,
    pub exports: Vec<String>,
    pub diagnostics: Vec<Diagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map: Option<String>,
}

#[derive(Serialize)]
pub struct Failed {
    pub ok: bool,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

/// A position in the source: `start` and `end` are UTF-16 code unit offsets, as a JavaScript string index is; `line` and
/// `character` (of `start`) are 0-based, in UTF-16 code units.
#[derive(Serialize)]
pub struct Diagnostic {
    pub start: usize,
    pub end: usize,
    pub line: usize,
    pub character: usize,
    pub severity: Severity,
    pub message: String,
}

fn default_parameter_names() -> crate::services::ParameterNames {
    crate::services::ParameterNames::Literals
}
