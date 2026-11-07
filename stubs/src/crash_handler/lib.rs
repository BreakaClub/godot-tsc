//! A stand-in for Bun's `bun_crash_handler`, not Bun's file.
//!
//! The real crate installs signal handlers, symbolicates stack traces and reports crashes to Bun's servers; it pulls in
//! `bun_analytics`, `bun_io`, `bun_sys`, `bun_which` and `bun_zlib` for that. None of it applies to a transpiler that
//! runs inside a WebAssembly module or behind a pipe. What `bun_js_parser`, `bun_js_printer` and their dependencies
//! take from the real crate is kept here with the same names and semantics:
//!
//! - `scoped_action` / `Action` / `current_action`: what the current thread is doing, restored when the guard drops.
//!   The host reads it to say which file a panic happened in.
//! - `handle_oom::handle_oom`: out of memory is a panic with a message.
//! - the two `extern "Rust"` symbols that `bun_alloc` and `bun_core` resolve at link time
//!   (`__bun_crash_handler_out_of_memory`, `__bun_crash_handler_dump_stack_trace`).
//!
//! A panic is the host's to deal with (`crate::wasm` traps with the message kept for the host; `main.rs` lets the
//! process die): there is no crash report.

use core::cell::Cell;

/// What the current thread is working on (the variants `bun_crash_handler::Action` has).
#[derive(Clone, Copy, Debug)]
pub enum Action {
    // Stored in a thread-local, so typed `'static`; the guard of `scoped_action` restores the previous value before the
    // data it names is freed, as in Bun's crate.
    Parse(&'static [u8]),
    Visit(&'static [u8]),
    Print(&'static [u8]),
    Resolver,
    Dlopen(&'static [u8]),
}

impl core::fmt::Display for Action {
    fn fmt(&self, writer: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Action::Parse(path) => write!(writer, "parsing {}", bstr::BStr::new(path)),
            Action::Visit(path) => write!(writer, "visiting {}", bstr::BStr::new(path)),
            Action::Print(path) => write!(writer, "printing {}", bstr::BStr::new(path)),
            Action::Resolver => writer.write_str("resolving a module"),
            Action::Dlopen(path) => write!(writer, "loading native module: {}", bstr::BStr::new(path)),
        }
    }
}

thread_local! {
    static CURRENT_ACTION: Cell<Option<Action>> = const { Cell::new(None) };
}

/// The action the current thread is in, if any.
pub fn current_action() -> Option<Action> {
    CURRENT_ACTION.with(Cell::get)
}

/// Restores the previous action when dropped.
pub struct ActionGuard(Option<Action>);

impl Drop for ActionGuard {
    #[inline]
    fn drop(&mut self) {
        CURRENT_ACTION.with(|current| current.set(self.0));
    }
}

/// Sets the current action to `action` until the returned guard drops.
#[inline]
#[must_use]
pub fn scoped_action(action: Action) -> ActionGuard {
    let previous = CURRENT_ACTION.with(|current| current.replace(Some(action)));
    ActionGuard(previous)
}

pub mod handle_oom {
    use bun_alloc::AllocError;

    /// Unwraps a `Result<T, AllocError>`; running out of memory is a panic.
    pub fn handle_oom<T>(result: Result<T, AllocError>) -> T {
        match result {
            Ok(success) => success,
            Err(AllocError) => super::out_of_memory(),
        }
    }
}

#[cold]
#[inline(never)]
pub fn out_of_memory() -> ! {
    panic!("out of memory")
}

/// Resolved by `bun_alloc::out_of_memory()` at link time.
#[doc(hidden)]
#[unsafe(no_mangle)]
extern "Rust" fn __bun_crash_handler_out_of_memory() -> ! {
    out_of_memory()
}

/// Resolved by `bun_core::dump_current_stack_trace()` at link time. There is no symbolicator here: the host's panic
/// message is the report.
#[doc(hidden)]
#[unsafe(no_mangle)]
extern "Rust" fn __bun_crash_handler_dump_stack_trace(
    _first_address: Option<usize>,
    _limits: bun_core::DumpStackTraceOptions,
) {
}
