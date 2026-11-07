//! The stateful side of the library: the checker's project (the files in memory and what has been parsed of them) and the
//! requests that read or change it. A [`Service`] belongs to one thread, which is why nothing here is `Sync`.

use crate::check::{self, MemoryHost, Runs};
use crate::protocol::{Diagnostic, Done, Failed, FileText, Pong, Request, Response, Severity};
use std::panic::{AssertUnwindSafe, catch_unwind};

/// One project and the work on it.
#[derive(Default)]
pub struct Service {
    host: MemoryHost,
    runs: Runs,
}

/// A response that is a failure with one message and no position.
pub fn failure(message: String) -> String {
    let failed = Response::Failed(Failed {
        ok: false,
        diagnostics: vec![Diagnostic { start: 0, end: 0, line: 0, character: 0, severity: Severity::Error, message }],
    });
    serde_json::to_string(&failed).expect("a response is always serializable")
}

fn text_of_panic(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a panic with no message".to_string())
}

impl Service {
    pub fn new() -> Service {
        Service::default()
    }

    /// Handles one request given as JSON. A request that is not valid gets a failed response with one diagnostic.
    pub fn handle_json(&mut self, request_json: &str) -> String {
        match serde_json::from_str::<Request>(request_json) {
            Ok(request) => self.handle(request),
            Err(error) => failure(format!("invalid request: {error}")),
        }
    }

    /// Handles one request. The response is always one JSON document. A panic (the checker asserts about what the host
    /// gave it: a lib file that is missing is a defect of the host) is caught where the platform can unwind and is a
    /// failed response; the project's parsed files are dropped, as whatever was in progress left them unknown.
    pub fn handle(&mut self, request: Request) -> String {
        let outcome = catch_unwind(AssertUnwindSafe(|| self.dispatch(request)));
        outcome.unwrap_or_else(|payload| {
            self.runs = Runs::default();
            failure(format!("internal error: {}", text_of_panic(payload.as_ref())))
        })
    }

    fn dispatch(&mut self, request: Request) -> String {
        match request {
            Request::Ping => {
                to_json(&Response::Pong(Pong { ok: true, name: crate::protocol::NAME, bun_revision: crate::protocol::BUN_REVISION }))
            }
            Request::Transpile(request) => to_json(&crate::transpile::transpile(&request)),
            Request::SetFile(file) => {
                self.set_file(file);
                to_json(&Response::Done(Done { ok: true }))
            }
            Request::SetFiles { files } => {
                for file in files {
                    self.set_file(file);
                }
                to_json(&Response::Done(Done { ok: true }))
            }
            Request::RemoveFile { path } => {
                self.runs.forget_for(path.as_bytes());
                self.host.remove(path.as_bytes());
                to_json(&Response::Done(Done { ok: true }))
            }
            Request::Hover { config, lib_dir, path, offset } => {
                crate::services::hover(&self.host, &mut self.runs, config.as_bytes(), lib_dir.as_bytes(), path.as_bytes(), offset)
            }
            Request::InlayHints { config, lib_dir, path, from, to, parameter_names } => crate::services::inlay_hints(
                &self.host,
                &mut self.runs,
                config.as_bytes(),
                lib_dir.as_bytes(),
                path.as_bytes(),
                from,
                to,
                parameter_names,
            ),
            Request::Check { config, lib_dir } => {
                let report = check::check(&self.host, &mut self.runs, config.as_bytes(), lib_dir.as_bytes());
                format!("{{\"ok\":true,\"report\":{report}}}")
            }
        }
    }

    fn set_file(&mut self, file: FileText) {
        self.runs.forget_for(file.path.as_bytes());
        self.host.set(file.path.into_bytes(), file.text.into_bytes());
    }
}

fn to_json(response: &Response) -> String {
    serde_json::to_string(response).expect("a response is always serializable")
}
