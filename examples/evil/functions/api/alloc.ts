// GET /api/alloc: unbounded allocation. Stopped by the V8 heap limit and the
// near-heap-limit callback (ops.md section 10): 503 RENOX_OOM, meter status oom,
// isolate recycled.
import type { Handler } from "renox";

// Module scope so nothing can be collected between iterations.
const hoard: number[][] = [];

export const GET: Handler = () => {
  for (;;) {
    // 1M doubles ≈ 8 MB per step.
    hoard.push(new Array<number>(1_000_000).fill(Math.random()));
  }
};
