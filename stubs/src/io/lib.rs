//! `bun_io` reduced to the part that `bun_js_printer` and `bun_sourcemap` use: the byte-writer module, which is
//! Bun's `src/io/write.rs`, unmodified. What Bun's crate has besides is the event loop, pipes, polling, child
//! processes' file descriptors and `bun_uws_sys`/`bun_spawn_sys`: none of it exists on WebAssembly, and a transpiler
//! has no use for it.

pub mod write;

pub use write::{AsFmt, DiscardingWriter, FixedBufferStream, FmtAdapter, IntLe, Result, Write};
