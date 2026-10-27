// Client library for the F0 spike runtime (issue #3), used by the B1, B4, B5
// and B17 scenarios: start and stop the runtime through run.sh, read the
// process memory from /proc, call the main service's probe endpoints, and
// route a request to one example app (optionally pinned to its own worker).

import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const here = dirname(new URL(import.meta.url).pathname);
export const RUN_SH = join(here, "run.sh");
export const CONTAINER = "renox-edge-runtime";

export type Policy = "per_worker" | "per_request" | "oneshot";
export type Mode = "source" | "docker";

export interface Runtime {
  pid: number;
  mode: Mode;
  port: number;
  base: string;
}

export interface StartOptions {
  policy?: Policy;
  port?: number;
  mode?: Mode;
}

/** The mode scenarios use: EDGE_RUNTIME_MODE, else docker when a local build is absent. */
export function defaultMode(): Mode {
  const env = process.env.EDGE_RUNTIME_MODE;
  if (env === "source" || env === "docker") return env;
  return "source";
}

export async function startRuntime(opts: StartOptions = {}): Promise<Runtime> {
  const port = opts.port ?? 9000;
  const mode = opts.mode ?? defaultMode();
  const args = [RUN_SH, "--mode", mode, "--background", "--port", String(port), "--policy", opts.policy ?? "per_worker"];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "inherit" });
  const out = (await new Response(proc.stdout).text()).trim();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`run.sh --background exited with ${code}`);
  const [pidText, modeText] = out.split(/\s+/);
  const pid = Number(pidText);
  if (!(pid > 0) || (modeText !== "source" && modeText !== "docker")) {
    throw new Error(`unexpected run.sh output: '${out}'`);
  }
  return { pid, mode: modeText, port, base: `http://127.0.0.1:${port}` };
}

export async function stopRuntime(): Promise<void> {
  const proc = Bun.spawn([RUN_SH, "--stop"], { stdout: "ignore", stderr: "inherit" });
  await proc.exited;
}

export interface Memory {
  /** Resident set size of the runtime process (all isolates are its threads). */
  vmRssMb: number;
  /** Proportional set size from smaps_rollup, when readable; null otherwise. */
  pssMb: number | null;
}

function kbField(text: string, field: string): number | null {
  const m = text.match(new RegExp(`^${field}:\\s+(\\d+) kB`, "m"));
  return m ? Number(m[1]) / 1024 : null;
}

/**
 * Memory of the runtime process. For a Docker runtime the host's /proc/<pid>
 * status is readable, but smaps_rollup needs ptrace access to a root-owned
 * process, so it is read from inside the container instead.
 */
export function readMemory(rt: Runtime): Memory {
  const statusPath = `/proc/${rt.pid}/status`;
  const rollupPath = `/proc/${rt.pid}/smaps_rollup`;
  let status: string;
  let rollup: string | null = null;
  if (rt.mode === "docker") {
    status = execText(["docker", "exec", CONTAINER, "cat", "/proc/1/status"]);
    rollup = execText(["docker", "exec", CONTAINER, "cat", "/proc/1/smaps_rollup"], true);
  } else {
    status = readFileSync(statusPath, "utf8");
    try {
      rollup = existsSync(rollupPath) ? readFileSync(rollupPath, "utf8") : null;
    } catch {
      rollup = null;
    }
  }
  const vmRssMb = kbField(status, "VmRSS");
  if (vmRssMb === null) throw new Error(`VmRSS not found in ${statusPath}`);
  const pssMb = rollup ? kbField(rollup, "Pss") : null;
  return { vmRssMb: round(vmRssMb), pssMb: pssMb === null ? null : round(pssMb) };
}

function execText(cmd: string[], tolerate = false): string {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    if (tolerate) return "";
    throw new Error(`${cmd.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

export interface HeapStats {
  totalHeapSize: number;
  usedHeapSize: number;
  externalMemory: number;
  [k: string]: number;
}

export interface Metrics {
  runtime: {
    mainWorkerHeapStats: HeapStats;
    activeUserWorkersCount?: number;
    retiredUserWorkersCount?: number;
    receivedRequestsCount?: number;
    handledRequestsCount?: number;
    [k: string]: unknown;
  };
  workers: Record<string, { servicePath: string; stats: HeapStats }>;
}

export async function metrics(rt: Runtime): Promise<Metrics> {
  const res = await fetch(`${rt.base}/_renox/metrics`);
  if (!res.ok) throw new Error(`metrics: HTTP ${res.status}`);
  return (await res.json()) as Metrics;
}

/** Sends one request to <app>; `worker` pins it to a dedicated isolate (B1). */
export async function callApp(
  rt: Runtime,
  app: string,
  path = "/",
  worker: string | null = null,
): Promise<{ status: number; ms: number; body: string }> {
  const url = new URL(path, rt.base);
  url.searchParams.set("__app", app);
  if (worker !== null) url.searchParams.set("__worker", worker);
  const start = performance.now();
  const res = await fetch(url);
  const body = await res.text();
  return { status: res.status, ms: performance.now() - start, body };
}

/** Time to response headers for one request; the body is drained afterwards. */
export async function timeToHeaders(rt: Runtime, app: string, path = "/", worker: string | null = null): Promise<number> {
  const url = new URL(path, rt.base);
  url.searchParams.set("__app", app);
  if (worker !== null) url.searchParams.set("__worker", worker);
  const start = performance.now();
  const res = await fetch(url);
  const ms = performance.now() - start;
  if (res.status !== 200) throw new Error(`${url.pathname}: HTTP ${res.status} ${await res.text()}`);
  await res.arrayBuffer();
  return ms;
}

/** `MemAvailable` from /proc/meminfo in MB, for guarding large worker counts. */
export function memAvailableMb(): number {
  const text = readFileSync("/proc/meminfo", "utf8");
  return kbField(text, "MemAvailable") ?? 0;
}

export function round(x: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms);
}
