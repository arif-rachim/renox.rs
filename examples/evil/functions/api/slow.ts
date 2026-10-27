// GET /api/slow?ms=N: busy-waits N ms of CPU, then answers. B12 drives it at a
// controlled rate. Under the CPU limit → 200; over it → 503 RENOX_CPU_LIMIT.
import type { Handler } from "renox";

/** Upper bound on `ms`, well above the paid CPU limit (500 ms). */
const MAX_MS = 10_000;

export const GET: Handler = ({ url }) => {
  const raw = url.searchParams.get("ms") ?? "10";
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_MS) {
    return Response.json({ error: `ms must be an integer in 0..${MAX_MS}` }, { status: 400 });
  }
  const start = performance.now();
  let spins = 0;
  while (performance.now() - start < ms) spins++;
  return Response.json({ ms, spins });
};
