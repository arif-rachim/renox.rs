// `renox dev` negative paths (docs/23-failure-modes.md section 3, "Watcher
// thrash"; #90): a burst of saves gives one rebuild and one route switch; a
// worker that exits is restarted with a message, not a hang; one that keeps
// exiting ends dev with exit 3; Ctrl-C is exit 130; no worker binary is exit
// 3 with the download instruction. A fake worker (fake-worker.ts) stands in
// for renox-worker, so these tests need no Rust build.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEBOUNCE_MS, portTaken, startDev, workerPath } from "../../src/commands/dev.ts";
import { EnvironmentError, EXIT } from "../../src/errors.ts";
import { app, fakeWorker, freePort, HEALTH, MAIN, VALID_TOML } from "./helpers.ts";

const dirs: string[] = [];
const project = (): string => {
  const d = app({ "renox.toml": VALID_TOML, "functions/api/health.ts": HEALTH });
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const hups = (dir: string): string[] => {
  const p = join(dir, ".renox", "hups.log");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean) : [];
};

/** Waits until `fn` is true (polling every 20 ms), or fails after `ms`. */
async function until(fn: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

describe("renox dev", () => {
  test(`50 saves in 500 ms give one rebuild and one route switch (debounce ${DEBOUNCE_MS} ms)`, async () => {
    const dir = project();
    const lines: string[] = [];
    const dev = await startDev({ project: dir, port: freePort(), worker: fakeWorker(dir), log: (l) => lines.push(l) });
    try {
      const first = dev.hash();
      const reload = dev.nextReload();
      const file = join(dir, "functions", "api", "health.ts");
      const t0 = performance.now();
      for (let i = 1; i <= 50; i++) {
        writeFileSync(file, `export const GET = () => Response.json({ save: ${i} });\n`);
        await Bun.sleep(10);
      }
      const span = performance.now() - t0;
      const { hash } = await reload;
      // Quiet time: no second rebuild arrives.
      await Bun.sleep(400);
      expect(span).toBeLessThan(1000);
      expect(lines.filter((l) => l.startsWith("rebuilt in"))).toHaveLength(1);
      expect(hash).not.toBe(first);
      expect(hups(dir)).toEqual([hash]);
      const res = await fetch(`http://localhost:${dev.port}/api/health`);
      expect(await res.text()).toEndWith(hash);
    } finally {
      await dev.stop();
    }
  }, 30_000);

  test("a burst that edits lib/ and then a function rebuilds with the new lib (no stale bundle)", async () => {
    const dir = app({
      "renox.toml": VALID_TOML,
      "lib/msg.ts": 'export const msg = "one";\n',
      "functions/api/health.ts": 'import { msg } from "../../lib/msg.ts";\nexport const GET = () => Response.json({ msg });\n',
    });
    dirs.push(dir);
    const dev = await startDev({ project: dir, port: freePort(), worker: fakeWorker(dir), log: () => {} });
    try {
      const before = dev.hash();
      const reload = dev.nextReload();
      writeFileSync(join(dir, "lib", "msg.ts"), 'export const msg = "two";\n');
      await Bun.sleep(5);
      // The function file is saved unchanged, last in the burst.
      writeFileSync(join(dir, "functions", "api", "health.ts"), readFileSync(join(dir, "functions", "api", "health.ts")));
      const { hash } = await reload;
      expect(hash).not.toBe(before);
      expect(readFileSync(join(dir, ".renox", "artifact", hash, "code", "functions", "api", "health.js"), "utf8")).toContain("two");
    } finally {
      await dev.stop();
    }
  }, 30_000);

  test("a failed build keeps the running artifact and its route", async () => {
    const dir = project();
    const lines: string[] = [];
    const dev = await startDev({ project: dir, port: freePort(), worker: fakeWorker(dir), log: (l) => lines.push(l) });
    try {
      const before = dev.hash();
      writeFileSync(join(dir, "functions", "api", "health.ts"), "export const GET = () => (;\n");
      await until(() => lines.some((l) => l.startsWith("build failed")), 5000, "the build failure");
      expect(lines.find((l) => l.startsWith("build failed"))).toStartWith("build failed: functions/api/health.ts:1:");
      expect(dev.hash()).toBe(before);
      expect(hups(dir)).toEqual([]);
      const routes = JSON.parse(readFileSync(join(dir, ".renox", "routes.json"), "utf8"));
      expect(routes.entries[0].deployment_hash).toBe(before);
    } finally {
      await dev.stop();
    }
  }, 30_000);

  test("a worker that exits is restarted with a message, and requests work again", async () => {
    const dir = project();
    const lines: string[] = [];
    const dev = await startDev({ project: dir, port: freePort(), worker: fakeWorker(dir), log: (l) => lines.push(l) });
    try {
      const base = `http://localhost:${dev.port}`;
      const pid1 = (await (await fetch(`${base}/api/health`)).text()).split(" ")[1];
      const restarted = dev.nextRestart();
      const crash = await fetch(`${base}/crash`);
      expect(crash.status).toBe(502);
      const pid2 = await restarted;
      expect(String(pid2)).not.toBe(pid1);
      expect(lines).toContain("renox dev: renox-worker exited (exit code 1); restarting");
      expect(lines.some((l) => l.startsWith("renox dev: renox-worker restarted"))).toBe(true);
      const again = await fetch(`${base}/api/health`);
      expect(await again.text()).toStartWith(`ok ${pid2} `);
      expect(JSON.parse(readFileSync(join(dir, ".renox", "dev.json"), "utf8")).workerRestarts).toBe(1);
    } finally {
      await dev.stop();
    }
  }, 30_000);

  test("a worker that keeps exiting ends renox dev with exit 3", async () => {
    const dir = project();
    const proc = Bun.spawn([process.execPath, MAIN, "dev", "--port", String(freePort())], {
      cwd: dir,
      env: { ...process.env, RENOX_WORKER_PATH: fakeWorker(dir) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = new Response(proc.stdout).text();
    await until(() => existsSync(join(dir, ".renox", "dev.json")), 10_000, "renox dev to start");
    // From now on every start fails; one crash triggers the restarts.
    writeFileSync(join(dir, ".renox", "crash-on-start"), "");
    const port = JSON.parse(readFileSync(join(dir, ".renox", "dev.json"), "utf8")).port as number;
    await fetch(`http://localhost:${port}/crash`).catch(() => undefined);
    const code = await Promise.race([proc.exited, Bun.sleep(20_000).then(() => -1)]);
    if (code === -1) proc.kill("SIGKILL");
    expect(code).toBe(EXIT.ENVIRONMENT);
    expect(await out).toContain("renox dev: renox-worker keeps exiting");
    expect(existsSync(join(dir, ".renox", "dev.json"))).toBe(false);
  }, 30_000);

  test("Ctrl-C stops the worker and exits 130", async () => {
    const dir = project();
    const proc = Bun.spawn([process.execPath, MAIN, "dev", "--port", String(freePort())], {
      cwd: dir,
      env: { ...process.env, RENOX_WORKER_PATH: fakeWorker(dir) },
      stdout: "pipe",
      stderr: "pipe",
    });
    await until(() => existsSync(join(dir, ".renox", "dev.json")), 10_000, "renox dev to start");
    const workerPid = Number((await (await fetch(`http://localhost:${JSON.parse(readFileSync(join(dir, ".renox", "dev.json"), "utf8")).port}/`)).text()).split(" ")[1]);
    proc.kill("SIGINT");
    expect(await proc.exited).toBe(EXIT.INTERRUPTED);
    await until(
      () => {
        try {
          process.kill(workerPid, 0);
          return false;
        } catch {
          return true;
        }
      },
      5000,
      "the worker to exit",
    );
  }, 30_000);

  test("a worker that cannot start is exit 3, not a hang", async () => {
    const dir = project();
    // A RENOX_WORKER_PATH that does not exist.
    const proc = Bun.spawn([process.execPath, MAIN, "dev", "--port", String(freePort())], {
      cwd: dir,
      env: { ...process.env, RENOX_WORKER_PATH: join(dir, "missing-dir", "renox-worker") },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(EXIT.ENVIRONMENT);
    expect(await new Response(proc.stderr).text()).toContain("does not exist");
    // And one that exits during startup.
    const sh = join(dir, "exits.sh");
    writeFileSync(sh, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    const p2 = Bun.spawn([process.execPath, MAIN, "dev", "--port", String(freePort())], {
      cwd: dir,
      env: { ...process.env, RENOX_WORKER_PATH: sh },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await Promise.race([p2.exited, Bun.sleep(15_000).then(() => -1)]);
    expect(code).toBe(EXIT.ENVIRONMENT);
    expect(await new Response(p2.stderr).text()).toContain("renox-worker exited during startup (exit code 7)");
  }, 30_000);
});

test("no RENOX_WORKER_PATH and no downloaded binary: exit 3 with the download instruction", () => {
  const empty = app({});
  dirs.push(empty);
  let err: unknown;
  try {
    workerPath("", empty);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(EnvironmentError);
  expect((err as EnvironmentError).exitCode).toBe(EXIT.ENVIRONMENT);
  expect((err as EnvironmentError).message).toBe("no renox-worker binary: RENOX_WORKER_PATH is not set and none was downloaded");
  expect((err as EnvironmentError).hint).toContain("bun cli/scripts/fetch-worker.ts");
});

test("a port in use is exit 3", async () => {
  const dir = project();
  const port = freePort();
  // Held on 127.0.0.1 only: renox dev listens on `localhost`, which on a
  // machine with IPv6 can bind ::1 beside it; the probe must still refuse.
  const holder = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("busy") });
  try {
    const p = Bun.spawn([process.execPath, MAIN, "dev", "--port", String(port)], {
      cwd: dir,
      env: { ...process.env, RENOX_WORKER_PATH: fakeWorker(dir) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await Promise.race([p.exited, Bun.sleep(15_000).then(() => -1)]);
    if (code === -1) p.kill("SIGKILL");
    expect(code).toBe(EXIT.ENVIRONMENT);
    expect(await new Response(p.stderr).text()).toContain(`renox dev: port ${port} is in use`);
  } finally {
    holder.stop(true);
  }
}, 30_000);

test("portTaken sees a server on either loopback family", async () => {
  const port = freePort();
  expect(await portTaken(port)).toBe(false);
  const v4 = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("v4") });
  try {
    expect(await portTaken(port)).toBe(true);
  } finally {
    v4.stop(true);
  }
});

test("renox mcp exits 130 on Ctrl-C", async () => {
  const dir = project();
  const p = Bun.spawn([process.execPath, MAIN, "mcp"], { cwd: dir, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  await Bun.sleep(300);
  p.kill("SIGINT");
  expect(await p.exited).toBe(EXIT.INTERRUPTED);
});
