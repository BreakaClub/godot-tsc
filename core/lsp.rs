//! A language server over the project in memory: the Language Server Protocol's JSON-RPC messages in, the messages to send back out.
//! One message is handled at a time, on the service's thread, and what it answers (a response, for a request) comes back with it, so a
//! host with no transport of its own passes messages through `{"op":"lsp","message":...}` and an LSP client sits on the other side.
//!
//! The project is the service's in-memory files. `initialize` names it with `initializationOptions`: `config` (the path of its tsconfig)
//! and `libDir` (where its lib files are). A document is a `file://` URI whose path is the file's path (`file:///project/main.ts` is
//! `/project/main.ts`); opening or changing one sets that file's text, as `setFile` does. Positions are UTF-16 (`positionEncoding`).
//!
//! Requests: `initialize`, `shutdown`, `textDocument/hover`, `definition`, `typeDefinition`, `references`, `documentHighlight`,
//! `prepareRename` and `rename`. Notifications: `initialized`, `exit`, `textDocument/didOpen`, `didChange` (full or incremental) and
//! `didClose` (the file stays in the project: it is closed in the editor, not deleted).

use crate::check::{MemoryHost, Positions, Runs};
use crate::navigate::{self, At, Occurrence, Place};
use serde_json::{Value, json};

/// JSON-RPC's and LSP's error codes.
const PARSE_ERROR: i64 = -32700;
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

    /// The response to a message that is not JSON.
    pub fn parse_error(error: &serde_json::Error) -> Value {
        json!({ "jsonrpc": "2.0", "id": Value::Null, "error": { "code": PARSE_ERROR, "message": format!("the message is not JSON: {error}") } })
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
                let text = host.text(path.as_bytes()).ok_or_else(|| refuse(INVALID_PARAMS, format!("{path} is not in the project")))?;
                let offset = Positions::new(text).of(Positions::new(text).byte_at(line, character) as u32).0;
                let hover = crate::services::hover(host, runs, &project.config, &project.lib_dir, path.as_bytes(), offset);
                let hover: Value = serde_json::from_str(&hover).map_err(|error| refuse(REQUEST_FAILED, error.to_string()))?;
                match hover.get("hover") {
                    Some(found) if !found.is_null() => {
                        let name = found.get("name").and_then(Value::as_str).unwrap_or_default();
                        let ty = found.get("type").and_then(Value::as_str).unwrap_or_default();
                        let shown = if name.is_empty() { ty.to_string() } else { format!("{name}: {ty}") };
                        Ok(json!({ "contents": { "kind": "markdown", "value": format!("```typescript\n{shown}\n```") } }))
                    }
                    _ => Ok(Value::Null),
                }
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
        self.project = Some(Project { config, lib_dir });
        self.shut_down = false;
        Ok(json!({
            "capabilities": {
                "positionEncoding": "utf-16",
                // Incremental: a change carries the range it replaces.
                "textDocumentSync": { "openClose": true, "change": 2 },
                "hoverProvider": true,
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
