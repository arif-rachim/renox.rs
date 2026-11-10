// Arabic typography and right-to-left (F7-203, #729): Noto Sans Arabic from public/ (preloaded only on an Arabic page, copied unchanged
// from @fontsource/noto-sans-arabic, small), an app.css with logical properties only, numbers, codes and phones isolated
// left to right on every page that prints them, and an Arabic catalogue with nothing left in English. The layout itself is
// audited in a browser by bench/lighthouse/rtl-audit.ts.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { app } from "@renoxium/sdk/test";

const t = await app();
const PASSWORD = "correct horse battery";
const APP = join(import.meta.dir, "..");
const FONTS = ["noto-sans-arabic-arabic-400-normal.woff2", "noto-sans-arabic-arabic-700-normal.woff2"];
const PACKAGE = join(APP, "../../node_modules/@fontsource/noto-sans-arabic");

async function signIn(jar: string, email: string, next = "/") {
  const u = t.as(jar);
  expect((await u.action("/auth/login", "default", { email, password: PASSWORD, next })).status).toBe(303);
  return u;
}
const dispatcher = await signIn("dispatcher", "dispatcher.dubai@fixit.example");
const accountant = await signIn("accountant", "accountant.dubai@fixit.example");
const ali = await signIn("ali", "ali.dubai@fixit.example", "/me");

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

describe("the font", () => {
  test("an Arabic page preloads the regular weight from this origin; the English page does not", async () => {
    const ar = await dispatcher.page("/dispatch?lang=ar");
    expect(ar.html).toContain('<link rel="preload" as="font" type="font/woff2" crossorigin="" href="/fonts/noto-sans-arabic-arabic-400-normal.woff2"');
    const en = await dispatcher.page("/dispatch?lang=en");
    expect(en.html).not.toContain("/fonts/noto-sans-arabic");
  });

  // In the repository the package is in node_modules; a copy of the app (a scaffolded project, the examples test) has no such folder, and the
  // provenance in the head of app.css is then what the files are held to.
  const HAS_PACKAGE = existsSync(PACKAGE);
  const css = readFileSync(join(APP, "public/app.css"), "utf8");
  const provenance = css.slice(0, css.indexOf("*/"));

  test("public/fonts/ holds the two files byte for byte as the package ships them (and as app.css says), and the licence", () => {
    for (const f of FONTS) {
      const mine = sha(readFileSync(join(APP, "public/fonts", f)));
      expect(provenance).toContain(`${f} sha256 ${mine}`);
      if (HAS_PACKAGE) expect(mine).toBe(sha(readFileSync(join(PACKAGE, "files", f))));
    }
    const licence = readFileSync(join(APP, "public/fonts/NotoSansArabic-OFL.txt"), "utf8");
    expect(licence).toContain("SIL Open Font License");
    if (HAS_PACKAGE) expect(readFileSync(join(PACKAGE, "LICENSE"), "utf8")).toBe(licence);
  });

  test("the two files weigh under 120 KB together, and app.css names the package", () => {
    const total = FONTS.reduce((n, f) => n + statSync(join(APP, "public/fonts", f)).size, 0);
    expect(total).toBeLessThan(120 * 1024);
    expect(provenance).toMatch(/@fontsource\/noto-sans-arabic \d+\.\d+\.\d+/u);
    if (HAS_PACKAGE) {
      const version = (JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as { version: string }).version;
      expect(provenance).toContain(`@fontsource/noto-sans-arabic ${version}`);
    }
  });
});

describe("app.css", () => {
  const css = readFileSync(join(APP, "public/app.css"), "utf8");

  test("uses logical properties only: no left, right, margin-left, padding-right or text-align left or right", () => {
    expect(css.match(/\b(left|right)\b/gu)).toBeNull();
  });

  test("sets the Arabic face, line height and numerals", () => {
    expect(css).toMatch(/:lang\(ar\) \{[^}]*font-family: "Noto Sans Arabic"[^}]*line-height: 1\.8[^}]*letter-spacing: 0/u);
    expect(css).toMatch(/:lang\(ar\) :is\(h1[^{]*\{[^}]*line-height: 1\.5/u);
    expect(css).toMatch(/:lang\(ar\) :is\(em, i\) \{[^}]*font-style: normal/u);
    expect(css).toMatch(/\.num, td\.money, time \{ font-variant-numeric: tabular-nums; \}/u);
    // Western digits in both languages: nothing switches them.
    expect(css).not.toMatch(/font-variant-numeric: (?!tabular-nums)/u);
  });
});

// -- bidi isolation ---------------------------------------------------------------------------------------------------------

/** The value is printed inside an element whose own dir is ltr (an ancestor, or itself): what keeps it from jumping in an Arabic line. */
function isolated(html: string, value: string): boolean {
  const body = html.indexOf("<body");
  const spots: number[] = [];
  for (let at = html.indexOf(value, body); at >= 0; at = html.indexOf(value, at + 1)) {
    // Text only: not inside a tag (an href, a value).
    if (html.lastIndexOf("<", at) <= html.lastIndexOf(">", at)) spots.push(at);
  }
  return spots.length > 0 && spots.every((at) => isolatedAt(html, at));
}

function isolatedAt(html: string, at: number): boolean {
  // The nearest element that sets a direction is ltr and holds the value directly, or through inline children (a link, a span).
  return /<[a-z][\w-]*\b[^>]*\bdir="ltr"[^>]*>(?:[^<]|<(?:a|strong|b|span|bdi|small|em)\b[^>]*>)*$/u.test(html.slice(Math.max(0, at - 400), at));
}

describe("numbers, phones and codes in Arabic are isolated left to right", () => {
  const cases: { page: string; who: typeof dispatcher; values: string[] }[] = [
    { page: "/dispatch", who: dispatcher, values: ["J-000010", "J-000001"] },
    { page: "/jobs/jb_seed_10", who: dispatcher, values: ["J-000010", "+971561110005"] },
    { page: "/me/visits/jb_seed_10", who: ali, values: ["J-000010", "+971561110005"] },
    { page: "/customers/cu_dxb_04", who: dispatcher, values: ["+97144110004", "100123456700003", "ops@marinaheights.example"] },
    { page: "/quotes/qt_seed_02", who: dispatcher, values: ["Q-000002", "+971521110002"] },
    { page: "/invoices/INV-000001", who: accountant, values: ["INV-000001", "J-000013"] },
  ];
  for (const c of cases) {
    test(`${c.page}`, async () => {
      const res = await c.who.page(`${c.page}?lang=ar`);
      expect(res.status).toBe(200);
      for (const v of c.values) expect([v, isolated(res.html, v)]).toEqual([v, true]);
    });
  }
});

// -- the Arabic catalogue ---------------------------------------------------------------------------------------------------

function flat(o: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (typeof v === "object" && v !== null) Object.assign(out, flat(v, `${prefix}${k}.`));
    else out[`${prefix}${k}`] = String(v);
  }
  return out;
}

describe("i18n/ar.json", () => {
  const en = flat(JSON.parse(readFileSync(join(APP, "i18n/en.json"), "utf8")));
  const ar = flat(JSON.parse(readFileSync(join(APP, "i18n/ar.json"), "utf8")));
  // The two language names are the same text in both catalogues on purpose: each language is named in its own script.
  const SAME = ["app.lang.ar", "app.lang.en"];

  test("every value that differs from English holds an Arabic letter, and at most five keys are the same, each named here", () => {
    const same = Object.keys(ar).filter((k) => !k.startsWith("_meta.") && ar[k] === en[k]);
    expect(same.sort()).toEqual(SAME);
    expect(same.length).toBeLessThanOrEqual(5);
    const noArabic = Object.keys(ar).filter((k) => !k.startsWith("_meta.") && ar[k] !== en[k] && !/\p{Script=Arabic}/u.test(ar[k] as string));
    expect(noArabic).toEqual([]);
  });

  test("a placeholder inside a sentence is wrapped in the Unicode isolates, so a Latin code does not reorder it (the board's spoken sentences and the counts, which are digits, excepted)", () => {
    const bare = Object.keys(ar).filter((k) => !k.includes(".announce.") && k !== "dispatch.show_all" && /(?<!⁨)\{[a-z_]+\}|\{[a-z_]+\}(?!⁩)/u.test(ar[k] as string));
    expect(bare).toEqual([]);
  });
});
