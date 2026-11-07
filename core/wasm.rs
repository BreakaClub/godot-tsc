//! The module's exports, for the host that instantiates it (`WebAssembly.instantiate(bytes, {})`: the module has no
//! imports and one thread). The host copies a request into a buffer that `lc_alloc` makes and hands it over with
//! `lc_handle`; the response is at `lc_result()`, for the length that `lc_handle` returned.
//!
//! A panic traps (`unreachable`), after `lc_panic_message` has been set. The instance is not used again after a trap:
//! whatever was in progress is left as it was in its memory.

use std::cell::RefCell;

thread_local! {
    static SERVICE: RefCell<crate::Service> = RefCell::new(crate::Service::new());
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static PANIC: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// What a request needs: a panic leaves its message for `lc_panic_message` (with what the parser or printer was doing, if
/// it was doing something), and the parser's stack budget.
fn prepare() {
    std::panic::set_hook(Box::new(|info| {
        let mut message = info.to_string();
        if let Some(action) = bun_crash_handler::current_action() {
            message = format!("{message} (while {action})");
        }
        PANIC.with_borrow_mut(|kept| *kept = message.into_bytes());
    }));
    crate::native::set_stack_size(crate::STACK_FOR_THE_REQUEST);
}

/// A buffer of `len` bytes for the caller to fill and pass to `lc_handle`, which takes it.
#[unsafe(no_mangle)]
pub extern "C" fn lc_alloc(len: usize) -> *mut u8 {
    let mut buffer = std::mem::ManuallyDrop::new(vec![0u8; len]);
    buffer.as_mut_ptr()
}

/// Handles the request in the buffer (`len` bytes of UTF-8 JSON from `lc_alloc`). Takes the buffer. Returns the length of
/// the response, which `lc_result` points to.
///
/// # Safety
/// `pointer` and `len` are a buffer that `lc_alloc` made, filled by the caller, and not used by it again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn lc_handle(pointer: *mut u8, len: usize) -> usize {
    // SAFETY: as the caller promises.
    let bytes = unsafe { Vec::from_raw_parts(pointer, len, len) };
    prepare();
    let response = match std::str::from_utf8(&bytes) {
        Ok(request) => SERVICE.with_borrow_mut(|service| service.handle_json(request)),
        Err(error) => crate::invalid_utf8_response(&error),
    };
    RESULT.with_borrow_mut(|result| {
        *result = response.into_bytes();
        result.len()
    })
}

/// The response to the last `lc_handle`.
#[unsafe(no_mangle)]
pub extern "C" fn lc_result() -> *const u8 {
    RESULT.with_borrow(|result| result.as_ptr())
}

/// The message of the panic that trapped, and its length.
#[unsafe(no_mangle)]
pub extern "C" fn lc_panic_message() -> *const u8 {
    PANIC.with_borrow(|message| message.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn lc_panic_message_len() -> usize {
    PANIC.with_borrow(|message| message.len())
}
