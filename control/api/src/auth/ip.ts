// The client address of a request: the socket address Bun reports. A
// forwarded-for header is never trusted (control/api is reached directly).

import type { Context } from "hono";
import type { Env } from "../context.ts";

interface AddressSource {
  requestIP?: (req: Request) => { address: string } | null;
}

export function clientIp(c: Context<Env>): string | null {
  const server = c.env as AddressSource | undefined;
  try {
    return server?.requestIP?.(c.req.raw)?.address ?? null;
  } catch {
    return null;
  }
}
