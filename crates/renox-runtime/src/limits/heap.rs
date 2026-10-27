//! Heap limit per isolate (`docs/contracts/ops.md` section 10): V8's heap
//! limit from `CreateParams`, plus a near-heap-limit callback that raises the
//! limit for a moment (so V8 does not abort the whole process) and
//! terminates execution. The isolate is then disposed on its own thread.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use deno_core::{JsRuntime, v8};

/// Set when the isolate reached its heap limit.
#[derive(Default)]
pub struct HeapFlag(AtomicBool);

impl HeapFlag {
    pub fn hit(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Install the near-heap-limit callback on `js`.
pub fn install(js: &mut JsRuntime, flag: Arc<HeapFlag>) {
    let handle = js.v8_isolate().thread_safe_handle();
    js.add_near_heap_limit_callback(move |current, _initial| {
        if !flag.0.swap(true, Ordering::SeqCst) {
            handle.terminate_execution();
        }
        // Headroom so the terminating code can unwind instead of V8 calling
        // its fatal OOM handler (which aborts the process).
        current.saturating_mul(2)
    });
}

/// `used_heap_size` of the isolate now.
pub fn used_heap_bytes(js: &mut JsRuntime) -> u64 {
    let mut s = v8::HeapStatistics::default();
    js.v8_isolate().get_heap_statistics(&mut s);
    s.used_heap_size() as u64
}
