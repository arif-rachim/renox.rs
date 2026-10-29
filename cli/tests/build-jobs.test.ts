// #284: `renox build` of job routes (artifact.md 1.3; ops.md section 20):
// `jobs/*.ts` exporting `schedule` (and `tz`) becomes a `job` entry named
// by its file stem; V27 refuses a schedule that does not parse and an
// unknown time zone. The SDK's `parseSchedule` is the rule.

import { expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { parseSchedule } from "../../sdk/src/jobs.ts";
import { BuildError, buildFiles } from "../src/lib/build.ts";
import { validate } from "../src/lib/schema.ts";
import { schemas } from "../src/lib/schemas.ts";
import { app } from "./authz-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();
if (worker) process.env.RENOX_WORKER_PATH = worker;

const TOML = `[app]\nname = "jobs"\ntimezone = "Asia/Dubai"\n`;
const JOB = (schedule: string, tz = "Asia/Dubai") => `export const schedule = "${schedule}";
export const tz = "${tz}";
export async function run(ctx) { await ctx.db.execute("delete from app__carts where created_at < ?", [ctx.job.tick - 86400000]); }
`;

test("parseSchedule: numbers, *, lists, ranges, steps; out-of-range and malformed fields are refused", () => {
  expect(parseSchedule("0 3 * * *")).toEqual([[0], [3], Array.from({ length: 31 }, (_, i) => i + 1), Array.from({ length: 12 }, (_, i) => i + 1), [0, 1, 2, 3, 4, 5, 6, 7]]);
  expect((parseSchedule("*/15 9-17 1,15 * 1-5") as number[][])[0]).toEqual([0, 15, 30, 45]);
  expect(parseSchedule("0 24 * * *")).toBe("hour: 24 is outside 0-23");
  expect(parseSchedule("0 3 * *")).toMatch(/has 5 fields/u);
  expect(parseSchedule("0 3 L * *")).toMatch(/is not a number/u);
  expect(parseSchedule("*/0 * * * *")).toMatch(/step/u);
});

test.skipIf(!worker)("a job module becomes a job entry; V27 refuses a bad schedule or zone", async () => {
  const dir = app({ "renox.toml": TOML, "jobs/nightly-cleanup.ts": JOB("0 3 * * *"), "functions/health.ts": "export const GET = () => new Response('ok');\n" });
  const bad = app({ "renox.toml": TOML, "jobs/cleanup.ts": JOB("0 25 * * *", "Mars/Olympus") });
  const missing = app({ "renox.toml": TOML, "jobs/cleanup.ts": "export async function run() {}\n" });
  try {
    const built = await buildFiles(dir);
    expect(built.manifest.routes.find((r) => r.kind === "job")).toEqual({ kind: "job", name: "nightly-cleanup", module: "jobs/nightly-cleanup", schedule: "0 3 * * *", tz: "Asia/Dubai" });
    expect(validate(schemas.manifest, built.manifest as never)).toEqual([]);
    const e = (await buildFiles(bad).catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(BuildError);
    expect(e.message).toContain('V27: jobs/cleanup.ts: schedule "0 25 * * *": hour: 25 is outside 0-23');
    expect(e.message).toContain('V27: jobs/cleanup.ts: tz "Mars/Olympus" is not an IANA time zone');
    const m = (await buildFiles(missing).catch((x: unknown) => x)) as Error;
    expect(m.message).toContain("V27: jobs/cleanup.ts: export const schedule");
  } finally {
    for (const d of [dir, bad, missing]) rmSync(d, { recursive: true, force: true });
  }
});
