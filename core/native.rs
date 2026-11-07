//! The native symbols that Bun's C and C++ side gives its Rust libraries, for a module that links the libraries and
//! nothing else: Bun's shims for binaries that link the parser (`vendor/bun/standalone-native.rs`, adapted for wasm),
//! and the one that `bun_sys` provides on every other target.

// Bun's file, written by scripts/vendor-bun.py: it is not formatted here (`cargo fmt -p` formats the modules a crate pulls in by path).
#[rustfmt::skip]
#[path = "../vendor/bun/standalone-native.rs"]
mod standalone;

pub use standalone::set_stack_size;

/// What `bun_sys` provides to `bun_core`'s output on every other target. Output is dropped: the module has no file
/// descriptors, and the response is its result.
#[cfg(target_family = "wasm")]
mod output_sink {
    use bun_core::{Error, Fd};

    #[repr(C)]
    struct Discard {
        writer: bun_core::io::Writer,
    }
    unsafe fn discard_write_all(_: *mut bun_core::io::Writer, _: &[u8]) -> Result<(), Error> {
        Ok(())
    }
    unsafe fn discard_flush(_: *mut bun_core::io::Writer) -> Result<(), Error> {
        Ok(())
    }

    bun_core::link_impl_OutputSink! {
        Sys for extern () => |_this| {
            stderr() => bun_core::output::File(Fd::stderr()),
            make_path(_cwd, _dir) => Err(Error::Unexpected),
            create_file(_cwd, _path) => Err(Error::Unexpected),
            quiet_writer_from_fd(_fd) => bun_core::output::QuietWriter::ZEROED,
            quiet_writer_adapt(_qw, _buf, _len) => {
                let mut out = bun_core::output::QuietWriterAdapter::uninit();
                let concrete = Discard { writer: bun_core::io::Writer { write_all: discard_write_all, flush: discard_flush } };
                // SAFETY: `out` is 64 bytes, aligned for pointers; `Discard` is two function pointers.
                core::ptr::write((&raw mut out).cast::<Discard>(), concrete);
                out
            },
            quiet_writer_write_all(_qw, _bytes) => true,
            quiet_writer_fd(_qw) => Fd::stderr(),
            tty_winsize(_fd) => None,
            is_terminal(_fd) => false,
            read(_fd, _buf) => Err(Error::Unexpected),
        }
    }
}
