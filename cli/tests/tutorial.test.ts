// The tutorial (#430): examples/tutorial/step-01 … step-10 and the chapters
// docs/tutorial/NN-*.md cannot drift from the platform or from each other.
//
// - `renox new --template tutorial` is step-01 (cli/templates/tutorial is
//   generated from it by examples/tutorial/sync-template.ts).
// - Each step holds every file of the one before (a strict superset), except
//   the files a chapter says it removes.
// - Drift: a code block of chapter NN whose line before is `` `path`: `` is
//   an excerpt of that file in step-NN, line for line. Changing a checkpoint
//   without its chapter, or the reverse, fails here.
// - With a worker: every step builds, passes `renox check` (the type check
//   included) and `renox test`, in a copy with the SDK linked as
//   `bun install` would.
import { describe, expect, test } from "bun:test";
import { cpSync, type Dirent, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { STEP_01, TEMPLATE_DIR, TEMPLATE_FILES } from "../../examples/tutorial/sync-template.ts";
import { check } from "../src/commands/check.ts";
import { startDev } from "../src/commands/dev.ts";
import { newApp } from "../src/commands/new.ts";
import { runTests } from "../src/commands/test.ts";
import { buildArtifact } from "../src/lib/build.ts";
import { freePort } from "./free-port.ts";

const REPO = join(import.meta.dir, "../..");
const STEPS = join(REPO, "examples/tutorial");
const CHAPTERS = join(REPO, "docs/tutorial");
const worker = process.env.RENOX_WORKER_PATH;

const SKIP = /(^|\/)(node_modules|\.renox)(\/|$)/u;
function files(root: string): string[] {
  return (readdirSync(root, { recursive: true, withFileTypes: true }) as Dirent[])
    .filter((d) => d.isFile())
    .map((d) => relative(root, join(d.parentPath, d.name)))
    .filter((f) => !SKIP.test(f))
    .sort();
}

const step = (n: number): string => join(STEPS, `step-${String(n).padStart(2, "0")}`);
const NUMBERS = Array.from({ length: 10 }, (_, i) => i + 1);

/** Files a chapter removes on purpose (it says so in its text). */
const REMOVED: Record<number, string[]> = {
  // Chapter 6: tasks belong to a team now; the sample rows would belong to none.
  6: ["seeds/tasks.sql"],
};

/** What `renox test` prints for each step: the number of passing tests. */
const PASSING: Record<number, number> = { 1: 2, 2: 2, 3: 3, 4: 4, 5: 6, 6: 4, 7: 5, 8: 6, 9: 7, 10: 7 };

/** The chapter file of step `n`. */
function chapter(n: number): string {
  const name = readdirSync(CHAPTERS).find((f) => f.startsWith(`${String(n).padStart(2, "0")}-`) && f.endsWith(".md"));
  if (name === undefined) throw new Error(`no chapter ${n} in docs/tutorial/`);
  return join(CHAPTERS, name);
}

interface Excerpt {
  file: string;
  line: number;
  path: string;
  body: string;
}

/** The code blocks of a chapter that name a checkpoint file on the line before. */
export function excerpts(markdown: string, file: string): Excerpt[] {
  const lines = markdown.split("\n");
  const out: Excerpt[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!/^```[\w+-]*$/u.test(lines[i] as string) || (lines[i] as string) === "```") continue;
    const named = /^`([^`\s]+)`:$/u.exec(lines[i - 1] as string);
    let end = i + 1;
    while (end < lines.length && lines[end] !== "```") end++;
    if (named !== null) out.push({ file, line: i + 1, path: named[1] as string, body: lines.slice(i + 1, end).join("\n") });
    i = end;
  }
  return out;
}

describe("the tutorial's checkpoints", () => {
  test("cli/templates/tutorial is step-01 (run examples/tutorial/sync-template.ts after changing step-01)", () => {
    expect(files(TEMPLATE_DIR)).toEqual(TEMPLATE_FILES.map((f) => `${f}.tpl`).sort());
    for (const f of TEMPLATE_FILES) expect(readFileSync(join(TEMPLATE_DIR, `${f}.tpl`), "utf8"), f).toBe(readFileSync(join(STEP_01, f), "utf8"));
  });

  test("each step holds every file of the one before, but the ones its chapter removes", () => {
    for (const n of NUMBERS.slice(1)) {
      const now = new Set(files(step(n)));
      const missing = files(step(n - 1)).filter((f) => !now.has(f) && !(REMOVED[n] ?? []).includes(f));
      expect(missing, `step-${n} lost files of step-${n - 1}`).toEqual([]);
      expect(files(step(n)).length, `step-${n} adds or changes nothing`).toBeGreaterThanOrEqual(files(step(n - 1)).length - (REMOVED[n] ?? []).length);
    }
  });

  test("drift: every named code block of a chapter is an excerpt of its checkpoint file", () => {
    let checked = 0;
    for (const n of NUMBERS) {
      const md = chapter(n);
      const blocks = excerpts(readFileSync(md, "utf8"), relative(REPO, md));
      expect(blocks.length, `${relative(REPO, md)} shows no checkpoint file`).toBeGreaterThan(0);
      for (const b of blocks) {
        const target = join(step(n), b.path);
        expect(existsSync(target), `${b.file}:${b.line} names ${b.path}, which step-${n} does not have`).toBe(true);
        const text = readFileSync(target, "utf8");
        expect(`\n${text}`.includes(`\n${b.body}\n`) || text === b.body, `${b.file}:${b.line} drifted from examples/tutorial/step-${String(n).padStart(2, "0")}/${b.path}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  test("the drift check catches a changed line", () => {
    const md = "`a.ts`:\n```ts\nconst x = 1;\n```\n";
    const [b] = excerpts(md, "x.md");
    expect(b).toMatchObject({ path: "a.ts", body: "const x = 1;", line: 2 });
    expect("\nconst x = 2;\n".includes(`\n${b?.body}\n`)).toBe(false);
    // Whole lines only: the tail of a line is not an excerpt of it.
    expect("\nexport const x = 1;\n".includes(`\n${b?.body}\n`)).toBe(false);
  });

  test("each step's README links its chapter", () => {
    for (const n of NUMBERS) {
      const slug = relative(CHAPTERS, chapter(n)).replace(/^\d+-/u, "").replace(/\.md$/u, "");
      expect(readFileSync(join(step(n), "README.md"), "utf8")).toContain(`https://renoxium.com/docs/tutorial-${slug}`);
    }
  });
});

/** A copy of the step with what `bun install` would put in node_modules: the SDK, TypeScript and the Bun types. */
function installed(n: number): string {
  const dir = join(mkdtempSync(join(tmpdir(), `renox-tutorial-${n}-`)), "board");
  cpSync(step(n), dir, { recursive: true, filter: (p) => !SKIP.test(relative(step(n), p)) });
  mkdirSync(join(dir, "node_modules/@renoxium"), { recursive: true });
  symlinkSync(join(REPO, "sdk"), join(dir, "node_modules/@renoxium/sdk"));
  for (const pkg of ["typescript", "bun-types"]) symlinkSync(join(REPO, "node_modules", pkg), join(dir, "node_modules", pkg));
  return dir;
}

test.skipIf(!worker)(
  "renox new --template tutorial runs under renox dev: / and /api/health",
  async () => {
    const dir = newApp("my-board", "tutorial", mkdtempSync(join(tmpdir(), "renox-tutorial-dev-")));
    const port = freePort();
    const dev = await startDev({ project: dir, port, log: () => {} });
    try {
      const home = await fetch(`http://localhost:${port}/`);
      expect(home.status).toBe(200);
      expect(await home.text()).toContain("Your app is running.");
      expect(await (await fetch(`http://localhost:${port}/api/health`)).json()).toEqual({ ok: true });
    } finally {
      await dev.stop();
    }
  },
  60_000,
);

describe.skipIf(!worker)("every step builds, checks and passes renox test", () => {
  for (const n of NUMBERS) {
    test(
      `step-${String(n).padStart(2, "0")}`,
      async () => {
        const dir = installed(n);
        await buildArtifact(dir, mkdtempSync(join(tmpdir(), "renox-tutorial-build-")));
        const report = await check(dir, { types: "include" });
        expect(report.errors.map((e) => e.message)).toEqual([]);
        expect(report.findings).toEqual([]);
        const r = await runTests(dir, [], "pipe");
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain(` ${PASSING[n]} pass`);
        expect(r.out).toContain(" 0 fail");
      },
      180_000,
    );
  }
});
