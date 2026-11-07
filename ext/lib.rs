//! `LiveCompile`: Bun's TypeScript checker and JavaScript compiler (`live_compile_core`) as a Godot class.
//!
//! Threading. The extension is a main-thread one, as `godot_react_ui` is: no Godot API is used anywhere but the thread
//! GodotJS calls from. The library runs on a plain Rust thread of its own that touches no Godot API and talks in strings.
//! A request is queued and answered later (`request_check` returns an id, `poll` hands over the finished replies), except
//! `compile`, which waits for its answer: a transpile takes milliseconds, and the caller hands over the text.
//!
//! The service is single flight: it runs one request at a time, in the order they were made, and a check that has not begun
//! when a newer one is made is dropped and answered as superseded. Nothing runs while nothing is asked: the thread waits on
//! a condition variable, and the caller asks for frames (or a timer) only while a request is outstanding.

use godot::prelude::*;
use live_compile_core::Service;
use live_compile_core::protocol::{FileText, Request, TranspileRequest};
use std::collections::VecDeque;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

struct LiveCompileExtension;

#[gdextension]
unsafe impl ExtensionLibrary for LiveCompileExtension {}

/// The stack the service thread is given. The parser, the printer and the checker recurse on the depth of the program; the
/// checker keeps a budget of the stack it has (`set_stack_size`) and reports the files it ran out of room in. On a desktop the memory is
/// reserved and not committed, so it is generous. In a browser a thread's stack is taken out of the one WebAssembly memory, and all of it
/// is committed: 8 MB, which is what UCGE's WebAssembly checker has and is enough for the labs.
#[cfg(not(target_os = "emscripten"))]
const SERVICE_STACK_BYTES: usize = 64 << 20;
#[cfg(target_os = "emscripten")]
const SERVICE_STACK_BYTES: usize = 8 << 20;
/// How long a call that waits (`compile`, `ping`) waits for the service thread before it says so. A wait is bounded because a thread
/// that never runs (in a browser, a pthread that the page has no worker for) must be an error, not a page that hangs.
const CALL_DEADLINE: Duration = Duration::from_secs(30);
const MILLISECONDS_PER_SECOND: f64 = 1000.0;
/// What the stack budget leaves for the frames above a request and for the guard page.
const STACK_RESERVE_BYTES: usize = 256 << 10;

/// What the thread is asked to do, in order.
enum Job {
    /// A change to the project: nothing is answered.
    Project(Request),
    /// A check, answered through `poll`; dropped if a newer check is made before it starts.
    Check { id: i64, config: String, lib_dir: String },
    /// An editor-services request (hover, inlay hints), answered through `poll` as `{"id":n,"kind":"query","result":{...}}`.
    Query { id: i64, request: Request },
    /// A request whose caller waits for the answer (a transpile, a ping).
    Call { request: Request, reply: Sender<String> },
}

#[derive(Default)]
struct Queue {
    jobs: VecDeque<Job>,
    shutdown: bool,
}

/// A finished request, as `poll` hands it over: `{"id":n,"kind":"check","result":{...}}`, or `"superseded":true` in place of
/// the result for a check that was dropped.
struct Reply(String);

struct Shared {
    queue: Mutex<Queue>,
    wake: Condvar,
    replies: Mutex<VecDeque<Reply>>,
}

impl Shared {
    fn lock_queue(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().expect("a thread that held the queue did not panic: requests are run under catch_unwind")
    }

    fn lock_replies(&self) -> MutexGuard<'_, VecDeque<Reply>> {
        self.replies.lock().expect("a thread that held the replies did not panic")
    }

    fn push(&self, job: Job) {
        let mut queue = self.lock_queue();
        if let Job::Check { id, .. } = &job {
            // A check that has not begun is replaced by this one; its asker is told.
            let dropped: Vec<i64> =
                queue.jobs.iter().filter_map(|queued| if let Job::Check { id, .. } = queued { Some(*id) } else { None }).collect();
            queue.jobs.retain(|queued| !matches!(queued, Job::Check { .. }));
            let mut replies = self.lock_replies();
            for superseded in dropped {
                replies.push_back(Reply(format!("{{\"id\":{superseded},\"kind\":\"check\",\"superseded\":true,\"by\":{id}}}")));
            }
        }
        queue.jobs.push_back(job);
        self.wake.notify_one();
    }

    fn next(&self) -> Option<Job> {
        let mut queue = self.lock_queue();
        loop {
            if let Some(job) = queue.jobs.pop_front() {
                return Some(job);
            }
            if queue.shutdown {
                return None;
            }
            queue = self.wake.wait(queue).expect("the queue's lock is not poisoned");
        }
    }
}

/// The thread's loop: one `Service`, made here because it is not `Send`.
fn serve(shared: &Shared) {
    live_compile_core::native::set_stack_size(SERVICE_STACK_BYTES - STACK_RESERVE_BYTES);
    let mut service = Service::new();
    while let Some(job) = shared.next() {
        match job {
            Job::Project(request) => {
                // A project change has no reply; a failure of one (a file removed that was never there) shows in the next check.
                let _ = service.handle(request);
            }
            Job::Check { id, config, lib_dir } => {
                let started = Instant::now();
                let result = service.handle(Request::Check { config, lib_dir });
                let ms = started.elapsed().as_secs_f64() * MILLISECONDS_PER_SECOND;
                shared.lock_replies().push_back(Reply(format!("{{\"id\":{id},\"kind\":\"check\",\"ms\":{ms:.3},\"result\":{result}}}")));
            }
            Job::Query { id, request } => {
                let started = Instant::now();
                let result = service.handle(request);
                let ms = started.elapsed().as_secs_f64() * MILLISECONDS_PER_SECOND;
                shared.lock_replies().push_back(Reply(format!("{{\"id\":{id},\"kind\":\"query\",\"ms\":{ms:.3},\"result\":{result}}}")));
            }
            Job::Call { request, reply } => {
                // The caller may have gone: a send that fails is nobody's loss.
                let _ = reply.send(service.handle(request));
            }
        }
    }
}

struct Worker {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl Worker {
    fn start() -> Worker {
        let shared = Arc::new(Shared { queue: Mutex::default(), wake: Condvar::new(), replies: Mutex::default() });
        let for_thread = Arc::clone(&shared);
        let thread = thread::Builder::new()
            .name("live-compile".to_string())
            .stack_size(SERVICE_STACK_BYTES)
            .spawn(move || serve(&for_thread))
            .expect("the operating system gives a thread");
        Worker { shared, thread: Some(thread) }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.shared.lock_queue().shutdown = true;
        self.shared.wake.notify_one();
        // Not joined: the thread may be in the middle of a check, and the object going away must not wait for it. It
        // finishes that request, finds the queue shut and ends.
        drop(self.thread.take());
    }
}

/// The checker and the compiler of one project.
#[derive(GodotClass)]
#[class(base=RefCounted, init)]
struct LiveCompile {
    worker: Option<Worker>,
    next_id: i64,
}

#[godot_api]
impl LiveCompile {
    fn worker(&mut self) -> &Worker {
        self.worker.get_or_insert_with(Worker::start)
    }

    /// Runs `request` on the service thread and waits for its answer.
    fn call(&mut self, request: Request) -> GString {
        let (reply, answer) = mpsc::channel();
        self.worker().shared.push(Job::Call { request, reply });
        let reply = answer.recv_timeout(CALL_DEADLINE).unwrap_or_else(|error| {
            live_compile_core::failure(format!(
                "the live-compile service thread did not answer: {error} (waited {} s)",
                CALL_DEADLINE.as_secs()
            ))
        });
        GString::from(&reply)
    }

    fn next_id(&mut self) -> i64 {
        self.next_id += 1;
        self.next_id
    }

    /// Starts the service thread now instead of at the first request. A browser starts a pthread from its pool of workers, and a page
    /// that asks for the thread and waits for it in the same turn can wait for ever if the pool is empty (docs/WEB.md): the owner starts it
    /// early, and the wait is bounded anyway.
    #[func]
    fn start(&mut self) {
        self.worker();
    }

    /// The library's name and the Bun revision it is made from, as JSON.
    #[func]
    fn ping(&mut self) -> GString {
        self.call(Request::Ping)
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

    /// Compiles TypeScript or JSX to JavaScript that is a function body (`require`, `exports`, `module`, `$RefreshReg$` and
    /// `$RefreshSig$` are its free identifiers), as JSON; waits for the answer.
    #[func]
    fn compile(&mut self, path: GString, source: GString, refresh: bool) -> GString {
        self.call(Request::Transpile(TranspileRequest {
            path: path.to_string(),
            source: source.to_string(),
            refresh,
            source_map: false,
            preserve_unused_imports: false,
        }))
    }

    /// Starts a check of the project whose configuration is at `config`, with the lib files in `lib_dir`. Returns the id the
    /// reply carries. A check not begun when the next is made is dropped.
    #[func]
    fn request_check(&mut self, config: GString, lib_dir: GString) -> i64 {
        let id = self.next_id();
        self.worker().shared.push(Job::Check { id, config: config.to_string(), lib_dir: lib_dir.to_string() });
        id
    }

    /// Starts an editor-services request, given as JSON (`{"op":"hover",...}`, `{"op":"inlayHints",...}`: `live-compile/core/protocol.rs`).
    /// Returns the id the reply carries, which `poll` hands over as a `query` reply. A request that is not valid is answered at once, as
    /// a failed result.
    #[func]
    fn request_query(&mut self, request_json: GString) -> i64 {
        let id = self.next_id();
        match serde_json::from_str::<Request>(&request_json.to_string()) {
            Ok(request) => self.worker().shared.push(Job::Query { id, request }),
            Err(error) => {
                let failed = live_compile_core::failure(format!("invalid request: {error}"));
                self.worker()
                    .shared
                    .lock_replies()
                    .push_back(Reply(format!("{{\"id\":{id},\"kind\":\"query\",\"ms\":0,\"result\":{failed}}}")));
            }
        }
        id
    }

    /// The oldest reply that is ready, as JSON, or an empty string. A caller with a request outstanding calls this until it
    /// has the reply.
    #[func]
    fn poll(&mut self) -> GString {
        let Some(worker) = self.worker.as_ref() else {
            return GString::new();
        };
        match worker.shared.lock_replies().pop_front() {
            Some(Reply(json)) => GString::from(&json),
            None => GString::new(),
        }
    }
}
