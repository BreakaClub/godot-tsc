//! The library behind `godot-tsc`: Bun's TypeScript checker and its JavaScript compiler (parser and printer) over one
//! project held in memory. `Service::handle` takes one request and gives one response (JSON). Three front ends call it:
//! the GDExtension (`../ext`, which owns a `Service` on a thread of its own), `main.rs` (frames on stdin and stdout, for
//! tests and tools) and `wasm` (a WebAssembly module with no imports).

#![feature(linkage)] // Bun's native shims are weak symbols (`native.rs`)

pub mod check;
mod complete;
mod lower;
mod lsp;
mod navigate;
pub mod native;
mod positions;
pub mod protocol;
mod service;
mod services;
mod symbols;
mod transpile;
#[cfg(target_family = "wasm")]
pub mod wasm;

pub use lsp::{superseded_response, supersede_key};
pub use service::{Service, failure};

/// The stack that a request may use (the parser, the printer and the checker recurse on the program's depth): the 8 MB of
/// the linker's stack on WebAssembly (`.cargo/config.toml`), of macOS's main thread and of the thread the extension makes
/// for its service, less what is above a request.
pub const STACK_FOR_THE_REQUEST: usize = (8 << 20) - (64 << 10);

/// The response to a frame that is not UTF-8.
pub fn invalid_utf8_response(error: &std::str::Utf8Error) -> String {
    failure(format!("invalid request: not UTF-8 ({error})"))
}
