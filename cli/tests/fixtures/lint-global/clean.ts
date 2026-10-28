// Nothing here is a global-state finding.
import type { Handler } from "renox";

let count = 0;
count = 1; // top-level initialisation
const LIMIT = 10;
let configured = false;
if (!configured) {
  configured = true; // a top-level block, not a handler
}

export const GET: Handler = async ({ url }) => {
  let local = 0;
  local++;
  const count = Number(url.searchParams.get("n")); // shadows the module binding
  if (count === LIMIT || count >= 3 || count == 2) local += count;
  const read = configured ? 1 : 0;
  const s = "count = 5; globalThis.x = 1";
  // count = 5; globalThis.x = 1
  const o = { count: 1, hits: count };
  o.count = 2;
  const g = globalThis.crypto.randomUUID();
  return Response.json({ local, read, s, o, g, same: globalThis.x === 1 });
};

export function param(count: number): number {
  count += 1; // a parameter, not the module binding
  return count;
}

export const arrow = (count: number): number => {
  count++;
  return count;
};

export const single = (configured: boolean) => {
  configured = !configured;
  return configured;
};

export function caught(): void {
  try {
    JSON.parse("{");
  } catch (count) {
    count = null;
  }
}

export const intentional = () => {
  // renox-allow-global: per-isolate cache of the parsed config, same for every request
  configured = true;
};
