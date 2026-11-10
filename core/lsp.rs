//! A language server over the project in memory: the Language Server Protocol's JSON-RPC messages in, the messages to send back out.
//! One message is handled at a time, on the service's thread, and what it answers (a response, for a request) comes back with it, so a
//! host with no transport of its own passes messages through `{"op":"lsp","message":...}` and an LSP client sits on the other side.
//!
//! The project is the service's in-memory files. `initialize` names it with `initializationOptions`: `config` (the path of its tsconfig)
//! and `libDir` (where its lib files are). A document is a `file://` URI whose path is the file's path (`file:///project/main.ts` is
//! `/project/main.ts`); opening or changing one sets that file's text, as `setFile` does. Positions are UTF-16 (`positionEncoding`).
//!
//! Requests: `initialize`, `shutdown`, `textDocument/hover`, `completion`, `signatureHelp`, `inlayHint`, `diagnostic`, `definition`,
//! `typeDefinition`, `references`, `documentHighlight`, `prepareRename`, `rename`, and `workspace/diagnostic`. Notifications:
//! `initialized`, `exit`, `textDocument/didOpen`, `didChange` (full or incremental) and `didClose` (the file stays in the project: it is
//! closed in the editor, not deleted).
//!
//! The service holds a server per session (`{"op":"lsp","session":"...","message":...}`), so one service serves several projects, each
//! session naming its own in `initialize`. `exit` ends a session.
//!
//! Diagnostics are pulled (`textDocument/diagnostic`, `workspace/diagnostic`): a check of the whole project, whose report is the
//! file's or every source's. The extension drops a diagnostics request that has not begun when a newer one for the same document comes,
//! and answers it with `ServerCancelled` (`ext/queue.rs`).

use crate::check::{MemoryHost, Positions, Runs};
use crate::navigate::{self, At, Occurrence, Place};
use serde_json::{Value, json};

/// JSON-RPC's and LSP's error codes.
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const SERVER_NOT_INITIALIZED: i64 = -32002;
const REQUEST_FAILED: i64 = -32803;

/// `DocumentHighlightKind`: a name that is read, and one that declares.
const HIGHLIGHT_READ: u8 = 2;
const HIGHLIGHT_WRITE: u8 = 3;

/// The server's state: the project once `initialize` has named it, and whether `shutdown` has been asked for.
#[derive(Default)]
pub struct Lsp {
    project: Option<Project>,
    shut_down: bool,
}

struct Project {
    config: Vec<u8>,
    lib_dir: Vec<u8>,
    /// Which arguments inlay hints name (`initializationOptions.inlayParameterNames`: `none`, `literals`, the default, or `all`).
    parameter_names: crate::services::ParameterNames,
}

/// LSP's `InlayHintKind`.
const INLAY_TYPE: u8 = 1;
const INLAY_PARAMETER: u8 = 2;

/// TypeScript's `DiagnosticCategory` (`Warning`, `Error`, `Suggestion`, `Message`) as LSP's `DiagnosticSeverity`.
fn severity(category: u64) -> u8 {
    const LSP_ERROR: u8 = 1;
    const LSP_WARNING: u8 = 2;
    const LSP_INFORMATION: u8 = 3;
    const LSP_HINT: u8 = 4;
    match category {
        0 => LSP_WARNING,
        1 => LSP_ERROR,
        2 => LSP_HINT,
        _ => LSP_INFORMATION,
    }
}

/// The LSP range of a diagnostic of the checker's report (`startPosition`, `endPosition`), or the file's start for one without.
fn diagnostic_range(diagnostic: &Value) -> Value {
    let position = |name: &str| {
        let line = diagnostic.pointer(&format!("/{name}/line")).and_then(Value::as_u64).unwrap_or(0);
        let character = diagnostic.pointer(&format!("/{name}/character")).and_then(Value::as_u64).unwrap_or(0);
        json!({ "line": line, "character": character })
    };
    json!({ "start": position("startPosition"), "end": position("endPosition") })
}

/// A diagnostic of the checker's report as LSP's.
fn lsp_diagnostic(diagnostic: &Value) -> Value {
    let related: Vec<Value> = diagnostic.get("relatedInformation").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|related| {
            let path = related.get("fileName").and_then(Value::as_str)?;
            Some(json!({
                "location": { "uri": uri_of(path), "range": diagnostic_range(related) },
                "message": related.get("messageText").and_then(Value::as_str).unwrap_or_default(),
            }))
        })
        .collect();
    let mut out = json!({
        "range": diagnostic_range(diagnostic),
        "severity": severity(diagnostic.get("category").and_then(Value::as_u64).unwrap_or(1)),
        "code": diagnostic.get("code").cloned().unwrap_or(Value::Null),
        "source": "ts",
        "message": diagnostic.get("messageText").and_then(Value::as_str).unwrap_or_default(),
    });
    if !related.is_empty() {
        out["relatedInformation"] = Value::Array(related);
    }
    out
}

/// `(line, character)` of a UTF-16 offset of `text`.
fn line_character(text: &[u8], units: usize) -> (usize, usize) {
    let mut seen = 0;
    let mut byte = text.len();
    for (at, &b) in text.iter().enumerate() {
        if b & 0xC0 != 0x80 {
            if seen >= units {
                byte = at;
                break;
            }
            seen += if b >= 0xF0 { 2 } else { 1 };
        }
    }
    let (_, line, character) = Positions::new(text).of(byte as u32);
    (line, character)
}

/// A request or notification that could not be served, as JSON-RPC reports it.
struct Refusal {
    code: i64,
    message: String,
}

fn refuse(code: i64, message: impl Into<String>) -> Refusal {
    Refusal { code, message: message.into() }
}

/// The path of a `file://` URI, percent-decoded.
fn path_of(uri: &str) -> Result<String, Refusal> {
    let Some(encoded) = uri.strip_prefix("file://") else {
        return Err(refuse(INVALID_PARAMS, format!("only file:// documents are served, not {uri}")));
    };
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[index] == b'%'
            && let (Some(high), Some(low)) = (bytes.get(index + 1).and_then(|&b| hex(b)), bytes.get(index + 2).and_then(|&b| hex(b)))
        {
            decoded.push((high * 16 + low) as u8);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).map_err(|_| refuse(INVALID_PARAMS, format!("{uri} is not UTF-8 when decoded")))
}

/// The `file://` URI of a path, with what a URI cannot hold percent-encoded.
fn uri_of(path: &str) -> String {
    let mut uri = String::from("file://");
    for &byte in path.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => uri.push(byte as char),
            _ => uri.push_str(&format!("%{byte:02X}")),
        }
    }
    uri
}

fn range(place: &Place) -> Value {
    json!({
        "start": { "line": place.start.0, "character": place.start.1 },
        "end": { "line": place.end.0, "character": place.end.1 },
    })
}

fn location(place: &Place) -> Value {
    json!({ "uri": uri_of(&place.path), "range": range(place) })
}

fn text_document_path(params: &Value) -> Result<String, Refusal> {
    let uri = params.pointer("/textDocument/uri").and_then(Value::as_str).ok_or_else(|| refuse(INVALID_PARAMS, "textDocument.uri is missing"))?;
    path_of(uri)
}

fn position_of(params: &Value) -> Result<(usize, usize), Refusal> {
    let number = |pointer: &str| params.pointer(pointer).and_then(Value::as_u64).map(|n| n as usize);
    match (number("/position/line"), number("/position/character")) {
        (Some(line), Some(character)) => Ok((line, character)),
        _ => Err(refuse(INVALID_PARAMS, "position is missing")),
    }
}

impl Lsp {
    /// Handles one JSON-RPC message, and returns the messages to send back: the response to a request, none for a notification.
    pub fn handle(&mut self, host: &mut MemoryHost, runs: &mut Runs, message: &Value) -> Vec<Value> {
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return vec![json!({ "jsonrpc": "2.0", "id": Value::Null, "error": { "code": INVALID_REQUEST, "message": "a message without a method" } })];
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let outcome = self.serve(host, runs, method, &params);
        let Some(id) = message.get("id") else {
            // A notification is answered with nothing, even when it could not be served.
            return Vec::new();
        };
        let response = match outcome {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(refusal) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": refusal.code, "message": refusal.message } }),
        };
        vec![response]
    }

    fn serve(&mut self, host: &mut MemoryHost, runs: &mut Runs, method: &str, params: &Value) -> Result<Value, Refusal> {
        match method {
            "initialize" => return self.initialize(params),
            "initialized" | "$/cancelRequest" | "$/setTrace" => return Ok(Value::Null),
            "exit" => {
                self.project = None;
                return Ok(Value::Null);
            }
            _ => {}
        }
        if self.shut_down {
            return Err(refuse(INVALID_REQUEST, "the server has been shut down"));
        }
        let Some(project) = self.project.as_ref() else {
            return Err(refuse(SERVER_NOT_INITIALIZED, "initialize has not been asked for"));
        };
        let at = |params: &Value| -> Result<(String, (usize, usize)), Refusal> { Ok((text_document_path(params)?, position_of(params)?)) };
        match method {
            "shutdown" => {
                self.shut_down = true;
                Ok(Value::Null)
            }
            "textDocument/didOpen" => {
                let path = text_document_path(params)?;
                let text = params.pointer("/textDocument/text").and_then(Value::as_str).ok_or_else(|| refuse(INVALID_PARAMS, "textDocument.text is missing"))?;
                set_text(host, runs, &path, text.as_bytes().to_vec());
                Ok(Value::Null)
            }
            "textDocument/didChange" => {
                let path = text_document_path(params)?;
                let changes = params.get("contentChanges").and_then(Value::as_array).ok_or_else(|| refuse(INVALID_PARAMS, "contentChanges is missing"))?;
                let mut text = host.text(path.as_bytes()).ok_or_else(|| refuse(INVALID_PARAMS, format!("{path} is not open")))?.to_vec();
                for change in changes {
                    let replacement = change.get("text").and_then(Value::as_str).ok_or_else(|| refuse(INVALID_PARAMS, "a change without text"))?;
                    text = match change.get("range") {
                        None => replacement.as_bytes().to_vec(),
                        Some(range) => {
                            let positions = Positions::new(&text);
                            let byte = |pointer: &str| -> Result<usize, Refusal> {
                                let number = |name: &str| range.pointer(&format!("{pointer}/{name}")).and_then(Value::as_u64).map(|n| n as usize);
                                match (number("line"), number("character")) {
                                    (Some(line), Some(character)) => Ok(positions.byte_at(line, character)),
                                    _ => Err(refuse(INVALID_PARAMS, "a change's range is not a range")),
                                }
                            };
                            let (start, end) = (byte("/start")?, byte("/end")?);
                            if start > end {
                                return Err(refuse(INVALID_PARAMS, "a change's range ends before it starts"));
                            }
                            [&text[..start], replacement.as_bytes(), &text[end..]].concat()
                        }
                    };
                }
                set_text(host, runs, &path, text);
                Ok(Value::Null)
            }
            "textDocument/didClose" | "textDocument/didSave" => Ok(Value::Null),
            "textDocument/hover" => {
                let (path, (line, character)) = at(params)?;
                let text = host.text(path.as_bytes()).ok_or_else(|| refuse(INVALID_PARAMS, format!("{path} is not in the project")))?.to_vec();
                let offset = Positions::new(&text).of(Positions::new(&text).byte_at(line, character) as u32).0;
                let hover = crate::services::hover(host, runs, &project.config, &project.lib_dir, path.as_bytes(), offset);
                let hover: Value = serde_json::from_str(&hover).map_err(|error| refuse(REQUEST_FAILED, error.to_string()))?;
                match hover.get("hover") {
                    Some(found) if !found.is_null() => {
                        let name = found.get("name").and_then(Value::as_str).unwrap_or_default();
                        let ty = found.get("type").and_then(Value::as_str).unwrap_or_default();
                        // The contents are one TypeScript code block: `name: type`, or the type alone where there is no name.
                        let shown = if name.is_empty() { ty.to_string() } else { format!("{name}: {ty}") };
                        let point = |key: &str| {
                            let (line, character) = line_character(&text, found.get(key).and_then(Value::as_u64).unwrap_or(0) as usize);
                            json!({ "line": line, "character": character })
                        };
                        Ok(json!({
                            "contents": { "kind": "markdown", "value": format!("```typescript\n{shown}\n```") },
                            // The name the hover is of, which an editor underlines and places its tooltip by.
                            "range": { "start": point("start"), "end": point("end") },
                        }))
                    }
                    _ => Ok(Value::Null),
                }
            }
            "textDocument/completion" => {
                let (path, (line, character)) = at(params)?;
                let at = At { config: &project.config, lib_dir: &project.lib_dir, path: path.as_bytes(), line, character };
                let found = crate::complete::completions(host, runs, &at);
                let (start, end) = found.replace;
                let replace = json!({ "start": { "line": start.0, "character": start.1 }, "end": { "line": end.0, "character": end.1 } });
                let items: Vec<Value> = found.items.iter().map(|item| {
                    let mut out = json!({
                        "label": item.label,
                        "kind": item.kind as u8,
                        "sortText": format!("{}{}", item.sort, item.label),
                        "textEdit": { "range": replace, "newText": item.label },
                    });
                    if let Some(detail) = &item.detail {
                        out["detail"] = Value::String(detail.clone());
                    }
                    out
                }).collect();
                Ok(json!({ "isIncomplete": false, "items": items }))
            }
            "textDocument/signatureHelp" => {
                let (path, (line, character)) = at(params)?;
                let at = At { config: &project.config, lib_dir: &project.lib_dir, path: path.as_bytes(), line, character };
                let Some(help) = crate::complete::signature_help(host, runs, &at) else {
                    return Ok(Value::Null);
                };
                let active = help.signatures.get(help.active_signature);
                // A rest parameter takes every argument from its own on.
                let active_parameter = match active.and_then(|signature| signature.rest) {
                    Some(rest) if help.active_parameter > rest => rest,
                    _ => help.active_parameter,
                };
                let signatures: Vec<Value> = help.signatures.iter().map(|signature| json!({
                    "label": signature.label,
                    "parameters": signature.parameters.iter().map(|&(from, to)| json!({ "label": [from, to] })).collect::<Vec<_>>(),
                })).collect();
                Ok(json!({ "signatures": signatures, "activeSignature": help.active_signature, "activeParameter": active_parameter }))
            }
            "textDocument/inlayHint" => {
                let path = text_document_path(params)?;
                let text = host.text(path.as_bytes()).ok_or_else(|| refuse(INVALID_PARAMS, format!("{path} is not in the project")))?.to_vec();
                let positions = Positions::new(&text);
                let offset = |pointer: &str| -> Result<usize, Refusal> {
                    let number = |name: &str| params.pointer(&format!("/range/{pointer}/{name}")).and_then(Value::as_u64).map(|n| n as usize);
                    match (number("line"), number("character")) {
                        (Some(line), Some(character)) => Ok(positions.of(positions.byte_at(line, character) as u32).0),
                        _ => Err(refuse(INVALID_PARAMS, "range is missing")),
                    }
                };
                let (from, to) = (offset("start")?, offset("end")?);
                let file = crate::services::FileInProject { config: &project.config, lib_dir: &project.lib_dir, path: path.as_bytes() };
                let hints = crate::services::inlay_hints(host, runs, &file, (from, to), project.parameter_names);
                let hints: Value = serde_json::from_str(&hints).map_err(|error| refuse(REQUEST_FAILED, error.to_string()))?;
                let hints: Vec<Value> = hints.get("hints").and_then(Value::as_array).into_iter().flatten().map(|hint| {
                    let (line, character) = line_character(&text, hint.get("position").and_then(Value::as_u64).unwrap_or(0) as usize);
                    let is_type = hint.get("kind").and_then(Value::as_str) == Some("type");
                    json!({
                        "position": { "line": line, "character": character },
                        "label": hint.get("label").and_then(Value::as_str).unwrap_or_default(),
                        "kind": if is_type { INLAY_TYPE } else { INLAY_PARAMETER },
                        "paddingRight": !is_type,
                    })
                }).collect();
                Ok(Value::Array(hints))
            }
            "textDocument/diagnostic" | "workspace/diagnostic" => {
                let report = crate::check::check(host, runs, &project.config, &project.lib_dir);
                let report: Value = serde_json::from_str(&report).map_err(|error| refuse(REQUEST_FAILED, error.to_string()))?;
                let diagnostics = report.get("diagnostics").and_then(Value::as_array).cloned().unwrap_or_default();
                let of = |path: &str| -> Vec<Value> {
                    diagnostics.iter().filter(|d| d.get("fileName").and_then(Value::as_str) == Some(path)).map(lsp_diagnostic).collect()
                };
                if method == "textDocument/diagnostic" {
                    let path = text_document_path(params)?;
                    return Ok(json!({ "kind": "full", "items": of(&path) }));
                }
                let mut paths: Vec<String> = report.get("files").and_then(Value::as_array).into_iter().flatten()
                    .filter_map(|path| path.as_str().map(str::to_string)).collect();
                for diagnostic in &diagnostics {
                    if let Some(path) = diagnostic.get("fileName").and_then(Value::as_str) && !paths.iter().any(|p| p == path) {
                        paths.push(path.to_string());
                    }
                }
                let items: Vec<Value> = paths.iter().map(|path| json!({ "uri": uri_of(path), "kind": "full", "version": Value::Null, "items": of(path) })).collect();
                // Beyond LSP: what the check saw, for a host that shows it (files in the program, those it ran out of stack in).
                Ok(json!({ "items": items, "filesLoaded": report.get("filesLoaded"), "incomplete": report.get("incomplete") }))
            }
            "textDocument/definition" | "textDocument/typeDefinition" => {
                let (path, (line, character)) = at(params)?;
                let at = At { config: &project.config, lib_dir: &project.lib_dir, path: path.as_bytes(), line, character };
                let places = match method {
                    "textDocument/definition" => navigate::definitions(host, runs, &at),
                    _ => navigate::type_definitions(host, runs, &at),
                };
                Ok(Value::Array(places.iter().map(location).collect()))
            }
            "textDocument/references" => {
                let (path, (line, character)) = at(params)?;
                let include_declaration = params.pointer("/context/includeDeclaration").and_then(Value::as_bool).unwrap_or(true);
                let at = At { config: &project.config, lib_dir: &project.lib_dir, path: path.as_bytes(), line, character };
                let found = navigate::references(host, runs, &at);
                Ok(Value::Array(found.iter().filter(|o| include_declaration || !o.is_declaration).map(|o| location(&o.place)).collect()))
            }
            "textDocument/documentHighlight" => {
                let (path, (line, character)) = at(params)?;
                let at = At { config: &project.config, lib_dir: &project.lib_dir, path: path.as_bytes(), line, character };
                let found: Vec<Occurrence> = navigate::highlights(host, runs, &at);
                let kind = |o: &Occurrence| if o.is_declaration { HIGHLIGHT_WRITE } else { HIGHLIGHT_READ };
                Ok(Value::Array(found.iter().map(|o| json!({ "range": range(&o.place), "kind": kind(o) })).collect()))
            }
            "textDocument/prepareRename" => {
                let (path, (line, character)) = at(params)?;
                let at = At { config: &project.config, lib_dir: &project.lib_dir, path: path.as_bytes(), line, character };
                match navigate::prepare_rename(host, runs, &at) {
                    Ok((place, placeholder)) => Ok(json!({ "range": range(&place), "placeholder": placeholder })),
                    Err(navigate::CannotRename(message)) => Err(refuse(REQUEST_FAILED, message)),
                }
            }
            "textDocument/rename" => {
                let (path, (line, character)) = at(params)?;
                let new_name = params.get("newName").and_then(Value::as_str).ok_or_else(|| refuse(INVALID_PARAMS, "newName is missing"))?;
                let at = At { config: &project.config, lib_dir: &project.lib_dir, path: path.as_bytes(), line, character };
                let edits = navigate::rename(host, runs, &at, new_name).map_err(|navigate::CannotRename(message)| refuse(REQUEST_FAILED, message))?;
                let mut changes = serde_json::Map::new();
                for (place, text) in edits {
                    let entry = changes.entry(uri_of(&place.path)).or_insert_with(|| Value::Array(Vec::new()));
                    if let Value::Array(list) = entry {
                        list.push(json!({ "range": range(&place), "newText": text }));
                    }
                }
                Ok(json!({ "changes": changes }))
            }
            _ => Err(refuse(METHOD_NOT_FOUND, format!("{method} is not served"))),
        }
    }

    fn initialize(&mut self, params: &Value) -> Result<Value, Refusal> {
        let option = |name: &str| params.pointer(&format!("/initializationOptions/{name}")).and_then(Value::as_str).map(|s| s.as_bytes().to_vec());
        let (Some(config), Some(lib_dir)) = (option("config"), option("libDir")) else {
            return Err(refuse(INVALID_PARAMS, "initializationOptions needs config (the tsconfig's path) and libDir (where the lib files are)"));
        };
        let parameter_names = match params.pointer("/initializationOptions/inlayParameterNames").and_then(Value::as_str) {
            None | Some("literals") => crate::services::ParameterNames::Literals,
            Some("none") => crate::services::ParameterNames::None,
            Some("all") => crate::services::ParameterNames::All,
            Some(other) => return Err(refuse(INVALID_PARAMS, format!("inlayParameterNames is none, literals or all, not {other}"))),
        };
        self.project = Some(Project { config, lib_dir, parameter_names });
        self.shut_down = false;
        Ok(json!({
            "capabilities": {
                "positionEncoding": "utf-16",
                // Incremental: a change carries the range it replaces.
                "textDocumentSync": { "openClose": true, "change": 2 },
                "hoverProvider": true,
                "completionProvider": { "triggerCharacters": ["."] },
                "signatureHelpProvider": { "triggerCharacters": ["(", ","] },
                "inlayHintProvider": true,
                "diagnosticProvider": { "interFileDependencies": true, "workspaceDiagnostics": true },
                "definitionProvider": true,
                "typeDefinitionProvider": true,
                "referencesProvider": true,
                "documentHighlightProvider": true,
                "renameProvider": { "prepareProvider": true },
            },
            "serverInfo": { "name": crate::protocol::NAME },
        }))
    }
}

/// Sets a file's text, as the service's `setFile` does: what was parsed of it is forgotten.
fn set_text(host: &mut MemoryHost, runs: &mut Runs, path: &str, text: Vec<u8>) {
    runs.forget_for(path.as_bytes());
    host.set(path.as_bytes().to_vec(), text);
}

/// LSP's `ServerCancelled`: the server cancelled the request, and the client asks again when it wants to.
const SERVER_CANCELLED: i64 = -32802;

/// What a queue of requests may drop a message for: a diagnostics request is replaced by a newer one of the same session for the same
/// document (or for the workspace) that comes before it has begun. Two messages with the same key are the same question asked again.
pub fn supersede_key(session: &str, message: &Value) -> Option<String> {
    let method = message.get("method").and_then(Value::as_str)?;
    message.get("id")?;
    let question = match method {
        "workspace/diagnostic" => method.to_string(),
        "textDocument/diagnostic" => format!("{method} {}", message.pointer("/params/textDocument/uri")?.as_str()?),
        _ => return None,
    };
    // A session's name may hold anything; its length keeps it from running into the question.
    Some(format!("{}:{session} {question}", session.len()))
}

/// The response (as the service's `{"ok":true,"messages":[...]}`) to a message dropped for a newer one with its key: `ServerCancelled`.
pub fn superseded_response(message: &Value) -> String {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let cancelled = json!({
        "jsonrpc": "2.0", "id": id,
        "error": { "code": SERVER_CANCELLED, "message": "a newer request for the same diagnostics took this one's place", "data": { "retriggerRequest": false } },
    });
    json!({ "ok": true, "messages": [cancelled] }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_diagnostics_request_is_superseded_by_the_same_question_of_the_same_session_only() {
        let workspace = |id: u64| json!({ "jsonrpc": "2.0", "id": id, "method": "workspace/diagnostic", "params": {} });
        let document = |id: u64, uri: &str| json!({ "jsonrpc": "2.0", "id": id, "method": "textDocument/diagnostic", "params": { "textDocument": { "uri": uri } } });
        assert_eq!(supersede_key("a", &workspace(1)), supersede_key("a", &workspace(2)));
        assert_ne!(supersede_key("a", &workspace(1)), supersede_key("b", &workspace(1)));
        assert_eq!(supersede_key("a", &document(1, "file:///x.ts")), supersede_key("a", &document(2, "file:///x.ts")));
        assert_ne!(supersede_key("a", &document(1, "file:///x.ts")), supersede_key("a", &document(1, "file:///y.ts")));
        // A session whose name ends like another's question is still another session.
        assert_ne!(supersede_key("a workspace/diagnostic", &workspace(1)), supersede_key("a", &workspace(1)));
        // Nothing else is superseded, nor is a notification.
        assert_eq!(supersede_key("a", &json!({ "jsonrpc": "2.0", "id": 1, "method": "textDocument/hover", "params": {} })), None);
        assert_eq!(supersede_key("a", &json!({ "jsonrpc": "2.0", "method": "workspace/diagnostic", "params": {} })), None);
    }
}
