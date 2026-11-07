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
use live_compile_core::protocol::{FileText, Request, TranspileRequest};
use live_compile_core::Service;
use std::collections::VecDeque;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};

struct LiveCompileExtension;

#[gdextension]
unsafe impl ExtensionLibrary for LiveCompileExtension {}

/// The stack the service thread is given. The parser, the printer and the checker recurse on the depth of the program; the
/// checker keeps a budget of the stack it has (`set_stack_size`) and reports the files it ran out of room in. The memory is
/// reserved, not committed.
const SERVICE_STACK_BYTES: usize = 64 << 20;
/// What the stack budget leaves for the frames above a request and for the guard page.
const STACK_RESERVE_BYTES: usize = 256 << 10;

/// What the thread is asked to do, in order.
enum Job {
    /// A change to the project: nothing is answered.
    Project(Request),
    /// A check, answered through `poll`; dropped if a newer check is made before it starts.
    Check { id: i64, config: String, lib_dir: String },
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
            let dropped: Vec<i64> = queue
                .jobs
                .iter()
                .filter_map(|queued| if let Job::Check { id, .. } = queued { Some(*id) } else { None })
                .collect();
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
                let result = service.handle(Request::Check { config, lib_dir });
                shared.lock_replies().push_back(Reply(format!("{{\"id\":{id},\"kind\":\"check\",\"result\":{result}}}")));
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
        GString::from(&answer.recv().unwrap_or_else(|_| live_compile_core::failure("the service thread ended".to_string())))
    }

    fn next_id(&mut self) -> i64 {
        self.next_id += 1;
        self.next_id
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
