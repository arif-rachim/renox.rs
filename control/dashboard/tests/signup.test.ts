// #488: the sign-up form explains every field (hints in English and Arabic),
// derives the workspace id from the workspace name until the person edits the
// id, shows the id rule and the first offending character before submit, and
// suggests `<id>-2` when the id is taken. The slug, the check and the lock are
// pure functions of public/account.js, tested here without a browser; the page
// is checked as a template, and the real script runs against a minimal fake form.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// account.js is a classic script that also exports its pure helpers under CommonJS.
// @ts-expect-error plain JavaScript without types
import account from "../public/account.js";

const { slugify, idProblem, suggestId, idSync } = account as {
  slugify: (s: string) => string;
  idProblem: (s: string) => { kind: string; char: string; index: number } | null;
  suggestId: (s: string) => string;
  idSync: (initial?: string) => { name(v: string): string; edit(v: string): string; id: string; locked: boolean };
};

const APP = join(import.meta.dir, "..");
const SCRIPT = readFileSync(join(APP, "public/account.js"), "utf8");
const html = readFileSync(join(APP, "pages/signup/index.html"), "utf8");
const catalog = (l: string): Record<string, any> => JSON.parse(readFileSync(join(APP, "i18n", `${l}.json`), "utf8"));
const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

test("the slug of a workspace name", () => {
  expect(slugify("Al Noor Clinic")).toBe("al-noor-clinic");
  expect(slugify("  Café  Déjà--Vu! ")).toBe("cafe-deja-vu");
  expect(slugify("R&D_Team 2")).toBe("r-d-team-2");
  expect(slugify("___x___")).toBe("x");
  expect(slugify("عيادة النور")).toBe("");
  expect(slugify("عيادة Noor")).toBe("noor");
  expect(slugify("")).toBe("");
  expect(slugify(`${"a".repeat(62)} bcd`)).toBe("a".repeat(62));
  expect(slugify("a".repeat(70)).length).toBe(63);
  for (const n of ["Al Noor Clinic", "Café 24/7", "x".repeat(100), "9 lives"]) expect(TENANT_ID.test(slugify(n))).toBe(true);
});

test("the first offending character of an id", () => {
  expect(idProblem("al-noor_clinic9")).toBeNull();
  expect(idProblem("")).toBeNull();
  expect(idProblem("Al-noor")).toEqual({ kind: "start", char: "A", index: 0 });
  expect(idProblem("-noor")).toEqual({ kind: "start", char: "-", index: 0 });
  expect(idProblem("_noor")).toEqual({ kind: "start", char: "_", index: 0 });
  expect(idProblem("al noor")).toEqual({ kind: "char", char: " ", index: 2 });
  expect(idProblem("al-noorB-c.d")).toEqual({ kind: "char", char: "B", index: 7 });
  expect(idProblem("نور")).toEqual({ kind: "start", char: "ن", index: 0 });
  expect(idProblem("a".repeat(64))?.kind).toBe("length");
  expect(idProblem("a".repeat(63))).toBeNull();
});

test("the suggestion for a taken id", () => {
  expect(suggestId("al-noor-clinic")).toBe("al-noor-clinic-2");
  expect(suggestId("al-noor-clinic-2")).toBe("al-noor-clinic-3");
  const s = suggestId("a".repeat(63));
  expect(s.length).toBe(63);
  expect(s.endsWith("-2")).toBe(true);
  expect(TENANT_ID.test(s)).toBe(true);
});

test("the id follows the name until it is edited by hand", () => {
  const s = idSync();
  expect(s.name("Al")).toBe("al");
  expect(s.name("Al Noor")).toBe("al-noor");
  expect(s.locked).toBe(false);
  expect(s.edit("my-clinic")).toBe("my-clinic");
  expect(s.locked).toBe(true);
  expect(s.name("Al Noor Clinic")).toBe("my-clinic");
  // Emptying the id hands it back to the name.
  s.edit("");
  expect(s.locked).toBe(false);
  expect(s.name("Al Noor Clinic")).toBe("al-noor-clinic");
  // A non-Latin name leaves the id empty for the person to type.
  expect(idSync().name("عيادة النور")).toBe("");
  // An id already in the field (a reload) is not overwritten.
  expect(idSync("kept").name("Other")).toBe("kept");
});

const HINTS = ["hint_email", "hint_password", "hint_name", "hint_id", "hint_dpa"];

test("every field of the form has a hint tied by aria-describedby, in English and Arabic", () => {
  for (const name of ["email", "password", "tenant_name", "tenant_id", "dpa"]) {
    const input = new RegExp(`<input[^>]*name="${name}"[^>]*>`, "u").exec(html)?.[0] ?? "";
    const ids = (/aria-describedby="([^"]+)"/u.exec(input)?.[1] ?? "").split(" ");
    expect([name, ids[0] !== ""]).toEqual([name, true]);
    for (const id of ids) expect([name, html.includes(`id="${id}"`)]).toEqual([name, true]);
  }
  // Name first, id second, and the name is required.
  expect(html.indexOf('name="tenant_name"')).toBeLessThan(html.indexOf('name="tenant_id"'));
  expect(/<input[^>]*name="tenant_name"[^>]*required/u.test(html)).toBe(true);
  for (const k of HINTS) expect(html).toContain(`key="dash.signup.${k}"`);
  for (const locale of ["en", "ar"]) {
    const s = catalog(locale).dash.signup as Record<string, string>;
    for (const k of [...HINTS, "example", "id_bad_char", "id_bad_start", "id_space", "id_try"]) expect([locale, k, typeof s[k]]).toEqual([locale, k, "string"]);
    if (locale === "ar") for (const k of HINTS) expect([k, /[؀-ۿ]/u.test(s[k] as string)]).toEqual([k, true]);
  }
  // The examples of the issue.
  for (const ex of ["you@example.com", "three dates and a coffee", "Al Noor Clinic", "al-noor-clinic"]) expect(html).toContain(`<code>${ex}</code>`);
  const en = catalog("en").dash.signup as Record<string, string>;
  expect(en.hint_password).toContain("At least 12 characters");
  expect(en.hint_id).toContain("cannot be changed");
  expect(en.hint_name_after).toBe("You can change it later.");
  const msgs = [...html.matchAll(/data-k="([a-z_]+)"/gu)].map((m) => m[1]);
  for (const k of ["err_workspace", "id_bad_char", "id_bad_start", "id_space", "id_try", "err_taken"]) expect(msgs).toContain(k);
});

// The real script against a minimal fake DOM: typing, hand edit, validation, 409.
type Listener = (ev?: unknown) => unknown;
function fakeEl(value = "") {
  const listeners: Record<string, Listener[]> = {};
  const strong = { textContent: "" };
  return {
    value, hidden: false, textContent: "", validity: "", checked: true, dataset: {} as Record<string, string>, strong,
    addEventListener(t: string, f: Listener) { (listeners[t] ??= []).push(f); },
    fire(t: string, ev: unknown = {}) { return Promise.all((listeners[t] ?? []).map((f) => f(ev))); },
    setCustomValidity(v: string) { this.validity = v; },
    setAttribute() {},
    querySelector() { return strong; },
    querySelectorAll() { return []; },
    scrollIntoView() {},
  };
}

test("the page script fills the id from the name, locks on hand edit, shows the rule, sends both fields and suggests -2 on 409", async () => {
  const msgs: Record<string, string> = { err_workspace: "RULE.", id_bad_char: "BAD:", id_bad_start: "START:", id_space: "SPACE", id_try: "Try:", err_taken: "TAKEN." };
  const f = { email: fakeEl("a@b.c"), password: fakeEl("x".repeat(12)), tenant_name: fakeEl(), tenant_id: fakeEl(), dpa: fakeEl() };
  const form = Object.assign(fakeEl(), { elements: f });
  const root = Object.assign(fakeEl(), { dataset: { api: "https://api.test", page: "signup" } });
  const els: Record<string, ReturnType<typeof fakeEl>> = { account: root, "signup-form": form, "id-error": fakeEl(), "account-error": fakeEl() };
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, fetch: g.fetch, window: g.window };
  g.window = {};
  const bodies: Record<string, string>[] = [];
  g.document = {
    getElementById: (id: string) => els[id] ?? null,
    querySelector: (sel: string) => { const k = /data-k="([^"]+)"/u.exec(sel)?.[1] ?? ""; return k in msgs ? { textContent: msgs[k] } : null; },
  };
  g.fetch = async (_u: string, init: { body?: string }) => {
    bodies.push(JSON.parse(init.body ?? "{}") as Record<string, string>);
    return new Response("{}", { status: 409, headers: { "content-type": "application/json" } });
  };
  try {
    // `module` exists under bun, so the script also exports; a fresh evaluation wires the page.
    new Function("module", SCRIPT)(undefined);
    f.tenant_name.value = "Al Noor Clinic";
    await f.tenant_name.fire("input");
    expect(f.tenant_id.value).toBe("al-noor-clinic");
    expect(els["id-error"]!.hidden).toBe(true);
    // Hand edit: the rule and the offending character show before submit.
    f.tenant_id.value = "Al Noor";
    await f.tenant_id.fire("input");
    expect(els["id-error"]!.hidden).toBe(false);
    expect(els["id-error"]!.textContent).toBe('RULE. START: "A"');
    expect(f.tenant_id.validity).toBe('RULE. START: "A"');
    f.tenant_id.value = "al noor";
    await f.tenant_id.fire("input");
    expect(els["id-error"]!.textContent).toBe("RULE. BAD: SPACE");
    f.tenant_id.value = "al-noor";
    await f.tenant_id.fire("input");
    expect(els["id-error"]!.hidden).toBe(true);
    expect(f.tenant_id.validity).toBe("");
    // The name no longer overwrites the id.
    f.tenant_name.value = "Al Noor Clinic Dubai";
    await f.tenant_name.fire("input");
    expect(f.tenant_id.value).toBe("al-noor");
    // Submit: both values are in the request; the 409 keeps err_taken and suggests <id>-2.
    await form.fire("submit", { preventDefault() {} });
    expect(bodies[0]).toMatchObject({ tenant_id: "al-noor", tenant_name: "Al Noor Clinic Dubai", dpa_accepted: true });
    expect(els["account-error"]!.strong.textContent).toBe("TAKEN. Try: al-noor-2");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  }
});

test("#688: the sign-up page forwards ?return_to= from an OAuth consent page to the API, and sends nothing when it is absent", async () => {
  const run = async (search: string) => {
    const f = { email: fakeEl("a@b.c"), password: fakeEl("x".repeat(12)), tenant_name: fakeEl("T"), tenant_id: fakeEl("t-1"), dpa: fakeEl() };
    const form = Object.assign(fakeEl(), { elements: f });
    const root = Object.assign(fakeEl(), { dataset: { api: "https://api.test", page: "signup" } });
    const els: Record<string, ReturnType<typeof fakeEl>> = { account: root, "signup-form": form, "id-error": fakeEl(), "account-error": fakeEl(), "signup-sent": fakeEl(), "sent-email": fakeEl(), "signup-more": fakeEl() };
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, fetch: g.fetch, window: g.window, location: g.location };
    g.window = {};
    g.location = { search };
    let body: Record<string, unknown> = {};
    g.document = { getElementById: (id: string) => els[id] ?? null, querySelector: () => null };
    g.fetch = async (_u: string, init: { body?: string }) => {
      body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      return new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
    };
    try {
      new Function("module", SCRIPT)(undefined);
      await form.fire("submit", { preventDefault() {} });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
    }
    return body;
  };
  expect((await run("?return_to=rnxreq_abc-DEF_123")).return_to).toBe("rnxreq_abc-DEF_123");
  expect(await run("")).not.toHaveProperty("return_to");
});
