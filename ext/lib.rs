//! `GodotTsc`: Bun's TypeScript checker and JavaScript compiler (`godot_tsc_core`) as a Godot class.
//!
//! Threading. The extension is a main-thread one (no gdext `experimental-threads`): no Godot API is used anywhere but the thread
//! GodotJS calls from. The library runs on a plain Rust thread of its own that touches no Godot API and talks in strings
//! (`queue.rs`).
//!
//! **No call waits for that thread.** A request (`request_compile`, `request_query`, `request_ping`) is queued
//! and returns an id at once, and `poll` hands over the finished replies, which carry their id; `cancel` takes a request back.
//! The caller is the engine's main thread, and on the Web the page's: a browser starts a pthread only when the page's thread
//! returns to its event loop, so a call that waited for the service thread would stall the page for as long as it takes the
//! thread to start (30 s on a cold page, measured in a Web export), and would never be answered if the page waited in
//! the turn that asked for the thread. The calls that remain synchronous are the ones that only move a value under a lock
//! that is never held while a request runs: `start`, `stop`, `set_file`, `set_files`, `remove_file`, `request_*`, `cancel`,
//! `poll` and `state`.
//!
//! The service is single flight: it runs one request at a time, in the order they were made, and a diagnostics request of the
//! language server that has not begun when a newer one for the same document is made is dropped and answered as cancelled. Nothing runs while nothing is asked: the thread waits on
//! a condition variable, and the caller asks for frames (or a timer) only while a request is outstanding.

mod queue;

use godot::prelude::*;
use godot_tsc_core::protocol::{FileText, Request, TranspileRequest};
use queue::{Job, Kind, Supersedes, Worker, answer};
use std::time::Duration;

struct GodotTscExtension;

#[gdextension]
unsafe impl ExtensionLibrary for GodotTscExtension {}

/// The stack the service thread is given. The parser, the printer and the checker recurse on the depth of the program; the
/// checker keeps a budget of the stack it has (`set_stack_size`) and reports the files it ran out of room in. On a desktop the memory is
/// reserved and not committed, so it is generous. In a browser a thread's stack is taken out of the one WebAssembly memory, and all of it
/// is committed: 8 MB, which was enough for every project it has checked (up to a few dozen files with React's declarations).
#[cfg(not(target_os = "emscripten"))]
const SERVICE_STACK_BYTES: usize = 64 << 20;
#[cfg(target_os = "emscripten")]
const SERVICE_STACK_BYTES: usize = 8 << 20;

/// The checker and the compiler of one project.
#[derive(GodotClass)]
#[class(base=RefCounted, init)]
struct GodotTsc {
    worker: Option<Worker>,
    next_id: i64,
}

#[godot_api]
impl GodotTsc {
    fn worker(&mut self) -> &Worker {
        self.worker.get_or_insert_with(|| Worker::start(SERVICE_STACK_BYTES))
    }

    fn next_id(&mut self) -> i64 {
        self.next_id += 1;
        self.next_id
    }

    /// Queues `request`, to be answered as a reply of `kind`, and returns its id.
    fn ask(&mut self, kind: Kind, request: Request) -> i64 {
        let id = self.next_id();
        let supersedes = match &request {
            Request::Lsp { message } => godot_tsc_core::supersede_key(message)
                .map(|key| Supersedes { key, superseded: godot_tsc_core::superseded_response(message) }),
            _ => None,
        };
        self.worker().shared.push(Job::Ask { id, kind, request, supersedes });
        id
    }

    /// Starts the service thread now instead of at the first request, so that a browser has begun its worker by the time the
    /// first request is asked for. Nothing waits for it either way.
    #[func]
    fn start(&mut self) {
        self.worker();
    }

    /// Ends the service thread, when it has finished the request it is in (an object going away does the same). Requests
    /// still outstanding get no reply. A request made afterwards starts a thread again.
    #[func]
    fn stop(&mut self) {
        self.worker = None;
    }

    /// Asks the library its name and the Bun revision it is made from. Returns the id of the `ping` reply.
    #[func]
    fn request_ping(&mut self) -> i64 {
        self.ask(Kind::Ping, Request::Ping)
    }

    /// Adds the file at `path` (absolute, in the checker's format: `/project/lab.tsx`) or replaces its text.
    #[func]
    fn set_file(&mut self, path: GString, text: GString) {
        let file = FileText { path: path.to_string(), text: text.to_string() };
        self.worker().shared.push(Job::Project(Request::SetFile(file)));
    }

    /// Several files at once; `paths` and `texts` are parallel.
    #[func]
    fn set_files(&mut self, paths: PackedStringArray, texts: PackedStringArray) {
        let files: Vec<FileText> = paths
            .as_slice()
            .iter()
            .zip(texts.as_slice())
            .map(|(path, text)| FileText { path: path.to_string(), text: text.to_string() })
            .collect();
        self.worker().shared.push(Job::Project(Request::SetFiles { files }));
    }

    /// Removes the file at `path`.
    #[func]
    fn remove_file(&mut self, path: GString) {
        self.worker().shared.push(Job::Project(Request::RemoveFile { path: path.to_string() }));
    }

    /// Starts compiling TypeScript or JSX to JavaScript that is a function body (`require`, `exports`, `module`, `$RefreshReg$` and
    /// `$RefreshSig$` are its free identifiers). Returns the id of the `compile` reply, whose result is the compiler's JSON.
    #[func]
    fn request_compile(&mut self, path: GString, source: GString, refresh: bool) -> i64 {
        self.ask(
            Kind::Compile,
            Request::Transpile(TranspileRequest {
                path: path.to_string(),
                source: source.to_string(),
                refresh,
                source_map: false,
                preserve_unused_imports: false,
            }),
        )
    }

    /// Starts a request given as JSON (`{"op":"lsp","message":{...}}`, a message for the language server: `core/protocol.rs`, `core/lsp.rs`).
    /// Returns the id the reply carries, which `poll` hands over as a `query` reply. A request that is not valid is answered at once, as
    /// a failed result.
    #[func]
    fn request_query(&mut self, request_json: GString) -> i64 {
        match serde_json::from_str::<Request>(&request_json.to_string()) {
            Ok(request) => self.ask(Kind::Query, request),
            Err(error) => {
                let id = self.next_id();
                let failed = godot_tsc_core::failure(format!("invalid request: {error}"));
                self.worker().shared.reply_now(answer(id, Kind::Query, 0.0, &failed));
                id
            }
        }
    }

    /// A hook for tests: holds the service thread for `milliseconds`, as a long check would, so that what happens to the caller while
    /// the service is busy can be tried. Returns the id of the `stall` reply.
    #[func]
    fn request_stall(&mut self, milliseconds: i64) -> i64 {
        let id = self.next_id();
        let duration = Duration::from_millis(u64::try_from(milliseconds).unwrap_or(0));
        self.worker().shared.push(Job::Stall { id, duration });
        id
    }

    /// Takes the request `id` back. If it had not begun it never runs; if it is running it finishes and its reply is dropped. Either
    /// way no reply for `id` is handed over by `poll` after this. False when nothing of it is left (it was answered and `poll` has handed
    /// the answer over).
    #[func]
    fn cancel(&mut self, id: i64) -> bool {
        self.worker.as_ref().is_some_and(|worker| worker.shared.cancel(id))
    }

    /// The oldest reply that is ready, as JSON, or an empty string. A caller with a request outstanding calls this until it
    /// has the reply.
    #[func]
    fn poll(&mut self) -> GString {
        let Some(worker) = self.worker.as_ref() else {
            return GString::new();
        };
        worker.shared.poll().map_or_else(GString::new, |json| GString::from(&json))
    }

    /// What the queue holds right now, as JSON, without asking the thread: `threadRunning` (the thread has begun and not ended),
    /// `queued`, `running` (the id of the request being served, or null), `replies` (finished and not taken) and `threadsAlive`
    /// (the service threads running in the whole process).
    #[func]
    fn state(&self) -> GString {
        let threads_alive = queue::threads_alive();
        let json = match self.worker.as_ref().map(|worker| worker.shared.state()) {
            Some(state) => format!(
                "{{\"started\":true,\"threadRunning\":{},\"queued\":{},\"running\":{},\"replies\":{},\"threadsAlive\":{threads_alive}}}",
                state.thread_running,
                state.queued,
                state.running.map_or_else(|| "null".to_string(), |id| id.to_string()),
                state.replies
            ),
            None => format!(
                "{{\"started\":false,\"threadRunning\":false,\"queued\":0,\"running\":null,\"replies\":0,\"threadsAlive\":{threads_alive}}}"
            ),
        };
        GString::from(&json)
    }
}
