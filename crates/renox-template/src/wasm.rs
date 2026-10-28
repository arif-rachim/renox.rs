//! The Wasm entry points of the transpiler (#43): a plain C ABI, no
//! `wasm-bindgen`, so the CLI instantiates the module with Bun's own
//! `WebAssembly` and needs no JavaScript glue. Built with
//! `cargo rustc -p renox-template --release --no-default-features
//! --features compiler --target wasm32-unknown-unknown --crate-type cdylib`
//! (`bench/scenarios/B16/build-wasm.sh`).
//!
//! Protocol: the host calls `renox_alloc(len)`, writes the input JSON there,
//! calls `renox_compile(ptr, len)`, and reads the result: the returned
//! pointer addresses 4 bytes of little-endian length followed by the output
//! JSON of [`crate::transpile::compile_json`]. It then frees both buffers
//! with `renox_free`.
//!
//! The `unsafe` here is the Wasm boundary only: the host hands raw pointers
//! into linear memory. Each block states what it relies on.

use std::alloc::{Layout, alloc, dealloc};

fn layout(len: usize) -> Layout {
    Layout::from_size_align(len.max(1), 1).expect("byte layout")
}

/// Allocates `len` bytes for the host to write into.
#[unsafe(no_mangle)]
pub extern "C" fn renox_alloc(len: usize) -> *mut u8 {
    // SAFETY: `layout` never has size 0; the pointer is returned to the host,
    // which frees it with `renox_free(ptr, len)`.
    unsafe { alloc(layout(len)) }
}

/// Frees a buffer from `renox_alloc` or `renox_compile` (`len` = its size).
///
/// # Safety
/// `ptr` must come from `renox_alloc(len)` or be a `renox_compile` result
/// of total size `len`, and must not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn renox_free(ptr: *mut u8, len: usize) {
    // SAFETY: the caller's contract above.
    unsafe { dealloc(ptr, layout(len)) }
}

/// Compiles the input JSON at `ptr..ptr+len`; returns a buffer of
/// `4 + output length` bytes (see the module doc).
///
/// # Safety
/// `ptr..ptr+len` must be initialised bytes written by the host into a
/// buffer from `renox_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn renox_compile(ptr: *const u8, len: usize) -> *mut u8 {
    // SAFETY: the caller's contract above.
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    let out = match std::str::from_utf8(input) {
        Ok(text) => crate::transpile::compile_json(text),
        Err(_) => r#"{"ok":false,"diagnostics":[{"file":"","line":0,"col":0,"message":"transpiler input is not UTF-8"}]}"#.to_string(),
    };
    let bytes = out.as_bytes();
    let total = 4 + bytes.len();
    let buf = renox_alloc(total);
    // SAFETY: `buf` has `total` bytes; the two copies fill exactly them.
    unsafe {
        std::ptr::copy_nonoverlapping((bytes.len() as u32).to_le_bytes().as_ptr(), buf, 4);
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf.add(4), bytes.len());
    }
    buf
}
