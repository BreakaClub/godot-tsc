//! The service thread's queue and its replies: plain Rust, with no Godot API in it, so it is tested without an engine.
//!
//! The caller (the engine's main thread; on the Web, the page's) only ever pushes a job, cancels one, takes a finished reply or
//! reads the state, and none of those waits for the service thread: each holds a lock for as long as it takes to move a value
//! and never while a request runs. That is the contract of the extension (`lib.rs`): a browser starts a pthread only when the
//! page's thread returns to its event loop, so a caller that waited for the service thread could wait for ever.
//!
//! The service is single flight: it runs one job at a time, in the order they were pushed, and a check that has not begun when
//! a newer one is pushed is dropped and answered as superseded. A job that has not begun can be cancelled; one that is running
//! is let finish, and its reply is dropped instead of kept. After `cancel(id)` returns true no reply for `id` is ever handed
//! over by `poll`.

use godot_tsc_core::Service;
use godot_tsc_core::protocol::Request;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const MILLISECONDS_PER_SECOND: f64 = 1000.0;
/// What the stack budget leaves for the frames above a request and for the guard page.
const STACK_RESERVE_BYTES: usize = 256 << 10;

/// The service threads that are running, in the whole process: the number a page needs to see stay at one.
static THREADS_ALIVE: AtomicUsize = AtomicUsize::new(0);

pub fn threads_alive() -> usize {
    THREADS_ALIVE.load(Ordering::SeqCst)
}

/// What a request is for. It names the `kind` of the reply that answers it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Check,
    Query,
    Compile,
    Ping,
    Stall,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Check => "check",
            Kind::Query => "query",
            Kind::Compile => "compile",
            Kind::Ping => "ping",
            Kind::Stall => "stall",
        }
    }
}

/// What the thread is asked to do, in order.
pub enum Job {
    /// A change to the project: nothing is answered.
    Project(Request),
    /// A request answered through `poll`: `{"id":n,"kind":"...","ms":t,"result":{...}}`.
    Ask { id: i64, kind: Kind, request: Request },
    /// Holds the thread for `duration`, as a long check would. A hook for tests of what happens while the service is busy.
    Stall { id: i64, duration: Duration },
}

impl Job {
    fn id(&self) -> Option<i64> {
        match self {
            Job::Project(_) => None,
            Job::Ask { id, .. } | Job::Stall { id, .. } => Some(*id),
        }
    }
}

/// The job the thread has taken and not finished.
struct Running {
    /// `None` for a change to the project, which nobody waits for.
    id: Option<i64>,
    /// Cancelled while it ran: its reply is dropped.
    cancelled: bool,
}

#[derive(Default)]
struct Queue {
    jobs: VecDeque<Job>,
    running: Option<Running>,
    shutdown: bool,
}

/// A reply, as `poll` hands it over: the finished request's id and kind, the service thread's own time and the result.
pub fn answer(id: i64, kind: Kind, ms: f64, result: &str) -> String {
    format!("{{\"id\":{id},\"kind\":\"{}\",\"ms\":{ms:.3},\"result\":{result}}}", kind.name())
}

/// What a check that was dropped is answered with.
fn superseded(id: i64, by: i64) -> String {
    format!("{{\"id\":{id},\"kind\":\"check\",\"superseded\":true,\"by\":{by}}}")
}

pub struct Shared {
    queue: Mutex<Queue>,
    wake: Condvar,
    replies: Mutex<VecDeque<String>>,
    /// The thread is running (it has begun, and not ended).
    thread_running: AtomicBool,
}

/// What the extension can tell about its queue without asking the thread.
#[derive(Debug, PartialEq, Eq)]
pub struct State {
    pub thread_running: bool,
    pub queued: usize,
    pub running: Option<i64>,
    pub replies: usize,
}

impl Shared {
    fn new() -> Shared {
        Shared { queue: Mutex::default(), wake: Condvar::new(), replies: Mutex::default(), thread_running: AtomicBool::new(false) }
    }

    fn lock_queue(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().expect("a thread that held the queue did not panic: requests are run under catch_unwind")
    }

    fn lock_replies(&self) -> MutexGuard<'_, VecDeque<String>> {
        self.replies.lock().expect("a thread that held the replies did not panic")
    }

    /// Queues a job. A check that has not begun is replaced by a newer one; its asker is told.
    pub fn push(&self, job: Job) {
        let mut queue = self.lock_queue();
        if let Job::Ask { id: newer, kind: Kind::Check, .. } = &job {
            let is_check = |queued: &Job| matches!(queued, Job::Ask { kind: Kind::Check, .. });
            let dropped: Vec<i64> = queue.jobs.iter().filter(|queued| is_check(queued)).filter_map(Job::id).collect();
            queue.jobs.retain(|queued| !is_check(queued));
            let mut replies = self.lock_replies();
            for older in dropped {
                replies.push_back(superseded(older, *newer));
            }
        }
        queue.jobs.push_back(job);
        self.wake.notify_one();
    }

    /// Hands a reply over to `poll` without a job: a request that was refused before it was queued.
    pub fn reply_now(&self, reply: String) {
        self.lock_replies().push_back(reply);
    }

    /// Takes the next job, waiting for one; `None` when the queue is shut. The job is the running one until `finish`.
    fn next(&self) -> Option<Job> {
        let mut queue = self.lock_queue();
        loop {
            if let Some(job) = queue.jobs.pop_front() {
                queue.running = Some(Running { id: job.id(), cancelled: false });
                return Some(job);
            }
            if queue.shutdown {
                return None;
            }
            queue = self.wake.wait(queue).expect("the queue's lock is not poisoned");
        }
    }

    /// The running job is done; `reply` is its answer, kept unless the job was cancelled while it ran.
    fn finish(&self, reply: Option<String>) {
        let mut queue = self.lock_queue();
        let cancelled = queue.running.take().is_some_and(|running| running.cancelled);
        if let (Some(reply), false) = (reply, cancelled) {
            self.lock_replies().push_back(reply);
        }
    }

    /// Cancels the request `id`. True when no reply for it will be handed over: it had not begun, or it is running and its reply
    /// will be dropped, or its reply was waiting and is gone. False when there is nothing of it left (it was answered and
    /// the answer taken, or the id is not one).
    pub fn cancel(&self, id: i64) -> bool {
        let mut queue = self.lock_queue();
        if let Some(position) = queue.jobs.iter().position(|job| job.id() == Some(id)) {
            queue.jobs.remove(position);
            return true;
        }
        if let Some(running) = queue.running.as_mut().filter(|running| running.id == Some(id)) {
            running.cancelled = true;
            return true;
        }
        let mut replies = self.lock_replies();
        let before = replies.len();
        replies.retain(|reply| !reply_is_for(reply, id));
        replies.len() != before
    }

    /// The oldest reply that is ready.
    pub fn poll(&self) -> Option<String> {
        self.lock_replies().pop_front()
    }

    pub fn state(&self) -> State {
        let queue = self.lock_queue();
        let replies = self.lock_replies().len();
        State {
            thread_running: self.thread_running.load(Ordering::SeqCst),
            queued: queue.jobs.len(),
            running: queue.running.as_ref().and_then(|running| running.id),
            replies,
        }
    }

    fn shut(&self) {
        self.lock_queue().shutdown = true;
        self.wake.notify_one();
    }
}

/// Whether `reply` answers request `id`: every reply begins `{"id":<id>,`.
fn reply_is_for(reply: &str, id: i64) -> bool {
    reply.strip_prefix("{\"id\":").is_some_and(|rest| rest.split_once(',').is_some_and(|(found, _)| found.parse::<i64>() == Ok(id)))
}

/// Counts the thread among those running for as long as it lives, whichever way it ends.
struct ThreadGuard {
    shared: Arc<Shared>,
}

impl ThreadGuard {
    fn begin(shared: &Arc<Shared>) -> ThreadGuard {
        THREADS_ALIVE.fetch_add(1, Ordering::SeqCst);
        shared.thread_running.store(true, Ordering::SeqCst);
        ThreadGuard { shared: Arc::clone(shared) }
    }
}

impl Drop for ThreadGuard {
    fn drop(&mut self) {
        self.shared.thread_running.store(false, Ordering::SeqCst);
        THREADS_ALIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The thread's loop: one `Service`, made here because it is not `Send`.
fn serve(shared: &Arc<Shared>, stack_bytes: usize) {
    let _alive = ThreadGuard::begin(shared);
    godot_tsc_core::native::set_stack_size(stack_bytes.saturating_sub(STACK_RESERVE_BYTES));
    let mut service = Service::new();
    while let Some(job) = shared.next() {
        match job {
            Job::Project(request) => {
                // A project change has no reply; a failure of one (a file removed that was never there) shows in the next check.
                let _ = service.handle(request);
                shared.finish(None);
            }
            Job::Ask { id, kind, request } => {
                let started = Instant::now();
                let result = service.handle(request);
                let ms = started.elapsed().as_secs_f64() * MILLISECONDS_PER_SECOND;
                shared.finish(Some(answer(id, kind, ms, &result)));
            }
            Job::Stall { id, duration } => {
                thread::sleep(duration);
                shared.finish(Some(answer(id, Kind::Stall, duration.as_secs_f64() * MILLISECONDS_PER_SECOND, "{\"ok\":true}")));
            }
        }
    }
}

/// The service thread and the queue it serves.
pub struct Worker {
    pub shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl Worker {
    pub fn start(stack_bytes: usize) -> Worker {
        let shared = Arc::new(Shared::new());
        let for_thread = Arc::clone(&shared);
        let thread = thread::Builder::new()
            .name("godot-tsc".to_string())
            .stack_size(stack_bytes)
            .spawn(move || serve(&for_thread, stack_bytes))
            .expect("the operating system gives a thread");
        Worker { shared, thread: Some(thread) }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.shared.shut();
        // Not joined: the thread may be in the middle of a request, and the object going away must not wait for it. It finishes that
        // request, finds the queue shut and ends, and a browser takes its worker back for the pool.
        drop(self.thread.take());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use godot_tsc_core::protocol::TranspileRequest;

    /// A bound on every wait of these tests: a thread that never answers is a failure, not a hung run.
    const DEADLINE: Duration = Duration::from_secs(60);
    const STACK_BYTES: usize = 64 << 20;
    const PAUSE: Duration = Duration::from_millis(2);

    fn wait_for<T>(what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
        let started = Instant::now();
        loop {
            if let Some(found) = probe() {
                return found;
            }
            assert!(started.elapsed() < DEADLINE, "timed out waiting for {what}");
            thread::sleep(PAUSE);
        }
    }

    fn transpile(source: &str) -> Request {
        Request::Transpile(TranspileRequest {
            path: "/project/x.tsx".to_string(),
            source: source.to_string(),
            refresh: false,
            source_map: false,
            preserve_unused_imports: false,
        })
    }

    fn ask(worker: &Worker, id: i64, kind: Kind, request: Request) {
        worker.shared.push(Job::Ask { id, kind, request });
    }

    fn stall(worker: &Worker, id: i64, ms: u64) {
        worker.shared.push(Job::Stall { id, duration: Duration::from_millis(ms) });
    }

    fn running_is(worker: &Worker, id: i64) {
        wait_for("the stall to begin", || (worker.shared.state().running == Some(id)).then_some(()));
    }

    #[test]
    fn requests_are_answered_in_order_with_their_kinds() {
        let worker = Worker::start(STACK_BYTES);
        ask(&worker, 1, Kind::Ping, Request::Ping);
        ask(&worker, 2, Kind::Compile, transpile("export const x = 1;"));
        let first = wait_for("the ping", || worker.shared.poll());
        let second = wait_for("the compile", || worker.shared.poll());
        assert!(first.starts_with("{\"id\":1,\"kind\":\"ping\",\"ms\":"), "{first}");
        assert!(second.starts_with("{\"id\":2,\"kind\":\"compile\",\"ms\":"), "{second}");
        assert!(second.contains("\"result\":{\"ok\":true,\"code\":"), "{second}");
    }

    #[test]
    fn a_check_that_has_not_begun_is_superseded() {
        let worker = Worker::start(STACK_BYTES);
        stall(&worker, 1, 300);
        running_is(&worker, 1);
        worker.shared.push(Job::Ask { id: 2, kind: Kind::Check, request: Request::Ping });
        worker.shared.push(Job::Ask { id: 3, kind: Kind::Check, request: Request::Ping });
        // The older check is told at once, while the thread is still busy.
        assert_eq!(worker.shared.poll().as_deref(), Some("{\"id\":2,\"kind\":\"check\",\"superseded\":true,\"by\":3}"));
        assert_eq!(worker.shared.poll(), None);
    }

    #[test]
    fn a_request_that_has_not_begun_can_be_cancelled_and_is_never_answered() {
        let worker = Worker::start(STACK_BYTES);
        stall(&worker, 1, 200);
        running_is(&worker, 1);
        ask(&worker, 2, Kind::Ping, Request::Ping);
        ask(&worker, 3, Kind::Ping, Request::Ping);
        assert!(worker.shared.cancel(2));
        let stalled = wait_for("the stall", || worker.shared.poll());
        let pinged = wait_for("the second ping", || worker.shared.poll());
        assert!(stalled.contains("\"kind\":\"stall\""), "{stalled}");
        assert!(pinged.starts_with("{\"id\":3,"), "{pinged}");
        assert_eq!(worker.shared.state().queued, 0);
        assert_eq!(worker.shared.poll(), None);
    }

    #[test]
    fn a_request_that_is_running_is_let_finish_and_its_reply_is_dropped() {
        let worker = Worker::start(STACK_BYTES);
        stall(&worker, 1, 100);
        running_is(&worker, 1);
        assert!(worker.shared.cancel(1));
        ask(&worker, 2, Kind::Ping, Request::Ping);
        let pinged = wait_for("the ping", || worker.shared.poll());
        assert!(pinged.starts_with("{\"id\":2,"), "the stall's reply was dropped: {pinged}");
        assert_eq!(worker.shared.poll(), None);
    }

    #[test]
    fn a_reply_that_is_waiting_is_taken_back_by_cancelling_its_request() {
        let worker = Worker::start(STACK_BYTES);
        ask(&worker, 1, Kind::Ping, Request::Ping);
        wait_for("the reply to be ready", || (worker.shared.state().replies == 1).then_some(()));
        assert!(worker.shared.cancel(1));
        assert_eq!(worker.shared.poll(), None);
        // Nothing of an id that is not one, or that was answered and taken, is left.
        assert!(!worker.shared.cancel(1));
        assert!(!worker.shared.cancel(99));
    }

    #[test]
    fn an_id_is_not_mistaken_for_one_it_begins() {
        assert!(reply_is_for("{\"id\":12,\"kind\":\"ping\"}", 12));
        assert!(!reply_is_for("{\"id\":12,\"kind\":\"ping\"}", 1));
        assert!(!reply_is_for("{\"id\":1,\"kind\":\"ping\"}", 12));
    }

    #[test]
    fn the_callers_calls_do_not_wait_for_a_busy_thread() {
        let worker = Worker::start(STACK_BYTES);
        let busy = Duration::from_millis(500);
        worker.shared.push(Job::Stall { id: 1, duration: busy });
        running_is(&worker, 1);
        let started = Instant::now();
        ask(&worker, 2, Kind::Compile, transpile("export const x = 1;"));
        worker.shared.push(Job::Project(Request::RemoveFile { path: "/project/none.tsx".to_string() }));
        let state = worker.shared.state();
        assert_eq!(worker.shared.poll(), None);
        assert!(worker.shared.cancel(2));
        let spent = started.elapsed();
        assert!(spent < busy / 10, "the caller's calls took {spent:?} while the thread was busy for {busy:?}");
        assert_eq!(state.running, Some(1));
        assert_eq!(state.queued, 2);
    }

    #[test]
    fn dropping_the_worker_ends_its_thread() {
        let worker = Worker::start(STACK_BYTES);
        let shared = Arc::clone(&worker.shared);
        wait_for("the thread to begin", || shared.state().thread_running.then_some(()));
        drop(worker);
        wait_for("the thread to end", || (!shared.state().thread_running).then_some(()));
    }
}
