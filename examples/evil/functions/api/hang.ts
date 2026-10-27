// GET /api/hang: a handler that never resolves and uses no CPU. Stopped by the
// wall-clock deadline (ops.md section 10): 504 RENOX_DEADLINE, meter status
// timeout, isolate kept.
import type { Handler } from "renox";

export const GET: Handler = async () => {
  await new Promise<never>(() => {});
  return new Response("unreachable");
};
