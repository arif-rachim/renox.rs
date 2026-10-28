// Every write below is a global-state finding (one per marked line).
import type { Handler } from "renox";

let count = 0;
let lastUser: string | null = null,
  hits = 0;
var legacy = 1;

export const GET: Handler = async ({ url }) => {
  count++; // FLAG
  lastUser = url.searchParams.get("u"); // FLAG
  hits += 1; // FLAG
  globalThis.cache = new Map(); // FLAG
  return Response.json({ count });
};

export async function POST(): Promise<Response> {
  ++legacy; // FLAG
  globalThis["user"] = "x"; // FLAG
  (globalThis as unknown as { a: { b: number } }).a.b = 1; // not caught: a cast hides the target
  Object.assign(globalThis, { leaked: true }); // FLAG
  return new Response(null);
}

export const actions = {
  save: (form: FormData) => {
    if (form.has("x")) {
      count = Number(form.get("x")); // FLAG
    }
    globalThis.n ??= 0; // FLAG
    return {};
  },
};

class Store {
  bump(): void {
    hits--; // FLAG
  }
}
export const store = new Store();
