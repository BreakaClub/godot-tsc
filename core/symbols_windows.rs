//! Windows only: every symbol of Bun's C and C++ side that the vendored libraries name anywhere, called or not.
//!
//! On the other platforms the linker drops code nothing reaches before it resolves symbols, so a symbol that only such code
//! names never has to exist; Linux and Android are linked with `-z defs`, which proves that nothing reachable names one
//! of these. MSVC's linker resolves every symbol of every object it loads first, so here each of them needs a definition.
//!
//! Two are real: the monotonic clock, and the flags for standard streams that are closed. The rest fail loudly if they are
//! ever called, like `symbols.rs`'s: the ones every platform's libraries name (which no platform reaches), and Windows' own
//! (libuv's file system and event loop, and the set-up of a `bun` process). The service compiles files it holds in memory
//! and starts no process.

use core::sync::atomic::AtomicI32;
use std::sync::OnceLock;
use std::time::Instant;

/// One flag for each of stdin, stdout and stderr: 1 if `bun_initialize_process` found the stream closed. This host does not
/// run that, and reports none as closed.
#[unsafe(no_mangle)]
pub static bun_is_stdio_null: [AtomicI32; 3] = [AtomicI32::new(0), AtomicI32::new(0), AtomicI32::new(0)];

/// A monotonic clock as seconds and nanoseconds. Bun's reads the performance counter from the system's start; this one counts
/// from its first reading, which is the same to callers that only compare readings.
#[unsafe(no_mangle)]
pub extern "C" fn clock_gettime_monotonic(sec: &mut i64, nsec: &mut i64) {
    static FIRST_READING: OnceLock<Instant> = OnceLock::new();
    let elapsed = FIRST_READING.get_or_init(Instant::now).elapsed();
    *sec = i64::try_from(elapsed.as_secs()).expect("a process does not run for 2^63 seconds");
    *nsec = i64::from(elapsed.subsec_nanos());
}

/// Defines each name as a function that fails. The linker matches names, not signatures, and none of them returns.
macro_rules! never_called {
    ($reason:literal: $($name:ident)*) => {
        $(
            #[allow(non_snake_case)]
            #[unsafe(no_mangle)]
            pub extern "C" fn $name() -> ! {
                unreachable!(concat!(stringify!($name), ": ", $reason));
            }
        )*
    };
}

never_called! {
    "this host reaches no code that calls it, on any platform":
    BunString__createAtom BunString__createExternalGloballyAllocatedLatin1
    BunString__createExternalGloballyAllocatedUTF16 BunString__createStaticExternal
    BunString__createStaticExternalLatin1WithHash BunString__createStaticExternalUTF16WithHash BunString__fromBytes
    BunString__fromLatin1 BunString__fromLatin1Unitialized BunString__fromUTF16 BunString__fromUTF16ToLatin1
    BunString__fromUTF16Unitialized BunString__makeThreadShareable BunString__threadIsolatedCopy
    BunString__tryCreateAtom Bun__ANSI__next Bun__WTFStringImpl__ensureHash Bun__ramSize
    Bun__visibleWidthExcludeANSI_latin1 Bun__visibleWidthExcludeANSI_utf16 URL__deinit URL__fragmentIdentifier
    URL__fromString URL__getHref URL__getHrefJoin URL__host URL__hostname URL__href URL__password URL__pathFromFileURL
    URL__pathname URL__port URL__protocol URL__username WTF__numberToExponential WTF__numberToFixed
    WTF__numberToPrecision WTF__parseES5Date ZSTD_DCtx_refPrefix ZSTD_compress ZSTD_compressBound ZSTD_createDCtx
    ZSTD_createDStream ZSTD_decompress ZSTD_decompressDCtx ZSTD_decompressStream ZSTD_defaultCLevel
    ZSTD_findDecompressedSize ZSTD_freeDCtx ZSTD_freeDStream ZSTD_getErrorCode ZSTD_getErrorName ZSTD_initDStream
    ZSTD_isError ZigSourceProvider__getSourceSlice highway_copy_ascii_prefix highway_count_mapping_delims
    highway_encode_hex_lower highway_index_of_newline_or_non_ascii highway_index_of_not_char highway_memmem16
    highway_parse_mappings simdutf__base64_decode_from_binary simdutf__base64_decode_from_binary_lenient
    simdutf__base64_length_from_binary simdutf__convert_valid_utf16le_to_utf8 simdutf__utf8_length_from_latin1
    simdutf__validate_utf16le
}

never_called! {
    "this host opens no files through libuv, runs no event loop and sets up no process":
    Bun__lockThreadSuspensionForExit bun_initialize_process rescle__setWindowsMetadata uv_close
    uv_disable_stdio_inheritance uv_fs_chmod uv_fs_chown uv_fs_close uv_fs_fchmod uv_fs_fchown uv_fs_fdatasync
    uv_fs_fstat uv_fs_fsync uv_fs_ftruncate uv_fs_lchown uv_fs_link uv_fs_lstat uv_fs_mkdir uv_fs_open uv_fs_read
    uv_fs_readlink uv_fs_rename uv_fs_req_cleanup uv_fs_rmdir uv_fs_stat uv_fs_statfs uv_fs_symlink uv_fs_unlink
    uv_fs_utime uv_fs_write uv_get_osfhandle uv_guess_handle uv_is_closing uv_loop_close uv_loop_init uv_open_osfhandle
    uv_pipe uv_run uv_walk windows_enable_stdio_inheritance
}
