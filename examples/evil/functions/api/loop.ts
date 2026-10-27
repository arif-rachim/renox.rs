// GET /api/loop: an infinite loop. Stopped by the per-request CPU watchdog
// (ops.md section 10): 503 RENOX_CPU_LIMIT, meter status cpu_limit, isolate recycled.
import type { Handler } from "renox";

export const GET: Handler = () => {
  for (;;) {
    // Burn CPU forever; never yields to the event loop.
  }
};
