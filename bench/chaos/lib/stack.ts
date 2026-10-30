// The stack every chaos scenario runs against (#104): control/api (PGlite in
// a directory, so it survives a restart; optionally S3 for artifacts) and
// two controlled renox-workers with replication on (a `file` replica shared
// by both, standing in for object storage), a node listener and a health
// listener each. Tenants are created through the API with one app each; the
// app's function writes a row on POST and reads the count and newest row on
// GET. Same shape as B18 (bench/scenarios/B18/failover.ts), made reusable.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { contentHash } from "../../../packages/artifact-validate/src/hash.ts";

export const REPO = join(import.meta.dir, "../../..");
export const DOMAIN = "renox.test";

const b32 = (n: number): string => [...randomBytes(n)].map((b) => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("");
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

/** Polls `f` every 50 ms until it answers non-null; throws after `ms`. */
export async function until<T>(what: string, ms: number, f: () => Promise<T | null>): Promise<T> {
  const deadline = performance.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v !== null) return v;
    if (performance.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** The artifact: POST /api/hits inserts a row; GET answers { n, id, at } (count, newest id and time). */
function artifact(dir: string, app: string): { hash: string; tar: Buffer } {
  const migration = "create table app__hits (id integer primary key, at integer not null);\n";
  const files: Record<string, string> = {
    "manifest.json": JSON.stringify({
      artifact: { version: 0 },
      app: { name: app, timezone: "UTC" },
      code: { format: "esm-dir", entry: { "functions/api/hits": "functions/api/hits.js" } },
      routes: [
        { kind: "function", method: "GET", path: "/api/hits", module: "functions/api/hits", export: "GET" },
        { kind: "function", method: "POST", path: "/api/hits", module: "functions/api/hits", export: "POST" },
      ],
      permissions: { network: [], secrets: [] },
    }),
    "code/functions/api/hits.js": `export async function GET({ db }) {
  return Response.json(await db.queryOne("select count(*) as n, coalesce(max(id), 0) as id, coalesce(max(at), 0) as at from app__hits"));
}
export async function POST({ db }) {
  const r = await db.execute("insert into app__hits (at) values (?)", [Date.now()]);
  return Response.json({ id: Number(r.lastInsertRowid) });
}\n`,
    "migrations/app/001_hits.sql": migration,
    "migrations/checksums.json": JSON.stringify({ version: 0, files: { "app/001_hits.sql": sha256(migration) } }),
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const hash = contentHash(new Map(Object.entries(files).map(([p, t]) => [p, new TextEncoder().encode(t)])));
  const tar = spawnSync("tar", ["-cf", "-", "-C", dir, "manifest.json", "code", "migrations"], { maxBuffer: 1 << 26 });
  if (tar.status !== 0) throw new Error(`tar: ${tar.stderr}`);
  return { hash, tar: tar.stdout as Buffer };
}

export interface Node {
  node: string;
  dir: string;
  /** The data directory (in `dir` unless the scenario gave one, e.g. a loop mount). */
  dataDir: string;
  port: number;
  health: number;
  listen: number;
  proc: Bun.Subprocess | null;
}

export interface Tenant {
  id: string;
  app: string;
  host: string;
  token: string;
  hash: string;
  tar: Buffer;
}

export interface StackOptions {
  /** Per node, a data directory to use instead of `<root>/<node>/data`. */
  dataDirs?: (string | undefined)[];
  idleTimeoutSecs?: number;
  /** S3 for the API's artifacts (storage-down); otherwise the API keeps them in memory. */
  s3?: { endpoint: string; accessKeyId: string; secretAccessKey: string; bucket?: string };
}

export interface Hit {
  status: number;
  body: Record<string, unknown> | null;
  text: string;
}

export class Stack {
  readonly root = mkdtempSync(join(tmpdir(), "renox-chaos-"));
  readonly operator = `renox_op_${b32(32)}`;
  readonly nodes: Node[] = [];
  readonly tenants: Tenant[] = [];
  apiPort = 0;
  nodePort = 0;
  private api: Bun.Subprocess | null = null;
  /** tmpfs mounts of the nodes' data directories (root only), unmounted on stop. */
  private readonly mounts: string[] = [];
  private readonly masterKey = randomBytes(32).toString("base64");

  private constructor(
    readonly worker: string,
    readonly opts: StackOptions,
  ) {}

  get apiUrl(): string {
    return `http://127.0.0.1:${this.apiPort}`;
  }

  static async start(worker: string, opts: StackOptions = {}): Promise<Stack> {
    const s = new Stack(worker, opts);
    s.apiPort = await freePort();
    s.nodePort = await freePort();
    await s.startApi();
    for (const [i, node] of ["node-chaos-1", "node-chaos-2"].entries()) {
      const dir = join(s.root, node);
      mkdirSync(dir, { recursive: true });
      const n: Node = { node, dir, dataDir: opts.dataDirs?.[i] ?? join(dir, "data"), port: await freePort(), health: await freePort(), listen: await freePort(), proc: null };
      // The disk watermarks (crate::disk) read the file system of the data
      // directory: on a shared or nearly full host disk a controlled worker
      // would refuse new cells for reasons that are not the scenario's. As
      // root (CI runs the harness with sudo) each node gets its own tmpfs.
      if (opts.dataDirs?.[i] === undefined && process.getuid?.() === 0) {
        mkdirSync(n.dataDir, { recursive: true });
        if (spawnSync("mount", ["-t", "tmpfs", "-o", "size=512m", "tmpfs", n.dataDir]).status === 0) s.mounts.push(n.dataDir);
      }
      const token = ((await (await s.op("POST", "/v1/admin/nodes", { node_id: node })).json()) as { token: string }).token;
      writeFileSync(join(dir, "node.token"), token, { mode: 0o600 });
      s.nodes.push(n);
      await s.startWorker(n);
    }
    return s;
  }

  /** control/api on the same ports and database directory every time. */
  async startApi(): Promise<void> {
    const s3 = this.opts.s3;
    this.api = Bun.spawn(["bun", join(REPO, "control/api/src/main.ts")], {
      env: {
        ...process.env,
        CONTROL_DATABASE_URL: `pglite:${join(this.root, "pg")}`,
        CONTROL_LISTEN_PORT: String(this.apiPort),
        CONTROL_NODE_LISTEN_HOST: "127.0.0.1",
        CONTROL_NODE_LISTEN_PORT: String(this.nodePort),
        CONTROL_OPERATOR_TOKEN_SHA256: sha256(this.operator),
        CONTROL_MASTER_KEY: this.masterKey,
        CONTROL_PLATFORM_DOMAIN: DOMAIN,
        // #308: the owner's verification mail is read from here, and a failed
        // erasure step is retried after 2 s instead of an hour.
        CONTROL_MAIL_OUTBOX_DIR: join(this.root, "mail"),
        CONTROL_ERASURE_RETRY_MS: "2000",
        ...(s3 === undefined
          ? {}
          : { CONTROL_S3_ENDPOINT: s3.endpoint, CONTROL_S3_ACCESS_KEY_ID: s3.accessKeyId, CONTROL_S3_SECRET_ACCESS_KEY: s3.secretAccessKey, CONTROL_S3_BUCKET: s3.bucket ?? "renox-artifacts" }),
      },
      stdout: "ignore",
      stderr: Bun.file(join(this.root, `api-${Date.now()}.log`)),
    });
    await until("the control API", 60_000, async () => ((await fetch(`${this.apiUrl}/v1/healthz`)).ok ? true : null));
  }

  async stopApi(): Promise<void> {
    this.api?.kill();
    await this.api?.exited;
    this.api = null;
  }

  async startWorker(n: Node): Promise<void> {
    mkdirSync(n.dataDir, { recursive: true });
    const idle = this.opts.idleTimeoutSecs === undefined ? "" : `idle_timeout_secs = ${this.opts.idleTimeoutSecs}\n`;
    writeFileSync(
      join(n.dir, "worker.toml"),
      `mode = "controlled"\nlisten = "127.0.0.1:${n.port}"\nnode_id = "${n.node}"\ndata_dir = "${n.dataDir}"\nartifacts_dir = "artifacts"\nmeters_dir = "meters"\nlogs_dir = "logs"\nmeter_flush_ms = 200\n${idle}fetch_blocked_addresses = ["203.0.113.250"]\n[gateway]\nrate_limit_per_ip = 100000.0\nrate_limit_burst = 100000\nmax_connections_per_ip = 1000\n[control]\nurl = "http://127.0.0.1:${this.nodePort}"\nnode_token_file = "node.token"\nhealth_listen = "127.0.0.1:${n.health}"\nnode_listen = "127.0.0.1:${n.listen}"\n[sandbox]\nallow_unsandboxed = true\n[process]\nrun_dir = "run"\n[replication]\nenabled = true\nreplica = "file"\npath = "${join(this.root, "replica")}"\nsync_interval_ms = 1000\nstop_grace_ms = 3000\n`,
    );
    n.proc = Bun.spawn([this.worker, "--config", join(n.dir, "worker.toml")], { cwd: n.dir, stdout: "ignore", stderr: Bun.file(join(n.dir, `worker-${Date.now()}.log`)) });
    await until(`${n.node} healthy`, 60_000, async () => ((await fetch(`http://127.0.0.1:${n.health}/healthz`)).ok ? true : null));
  }

  killWorker(n: Node, signal: NodeJS.Signals | number = "SIGKILL"): void {
    n.proc?.kill(signal);
    n.proc = null;
  }

  op(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.operator}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** A tenant with one active app (`<id>.renox.test`). */
  async tenant(id: string): Promise<Tenant> {
    const created = (await (await this.op("POST", "/v1/admin/tenants", { tenant_id: id, name: id, tier: "free" })).json()) as { token: { token: string } };
    const token = created.token.token;
    const auth = { authorization: `Bearer ${token}` };
    const app = id;
    await fetch(`${this.apiUrl}/v1/apps`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: app }) });
    const { hash, tar } = artifact(join(this.root, `artifact-${id}`), app);
    const t: Tenant = { id, app, host: `${app}.${DOMAIN}`, token, hash, tar };
    await this.deploy(t);
    this.tenants.push(t);
    return t;
  }

  /**
   * A tenant with an owner account (#308: erasure is the owner's, by
   * session): sign up with the tenant id, verify the address from the mail
   * the API wrote, sign in, and deploy the app with a token the session
   * created. Returns the tenant and the owner's session.
   */
  async ownedTenant(id: string): Promise<{ t: Tenant; session: { cookie: string; csrf: string } }> {
    const email = `owner-${id}@chaos.test`;
    const password = "correct horse battery";
    const json = (b: unknown) => ({ "content-type": "application/json", body: JSON.stringify(b) });
    const up = await fetch(`${this.apiUrl}/v1/account/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, tenant_id: id }) });
    if (up.status !== 202) throw new Error(`signup ${id}: ${up.status} ${await up.text()}`);
    const mailDir = join(this.root, "mail");
    const token = await until(`the verification mail of ${email}`, 10_000, async () => {
      for (const f of readdirSync(mailDir).filter((n) => n.endsWith("verify_email.txt"))) {
        const text = readFileSync(join(mailDir, f), "utf8");
        const m = text.includes(`To: ${email}`) ? /#token=([a-z2-7]{32})/u.exec(text) : null;
        if (m) return m[1] as string;
      }
      return null;
    });
    const verified = await fetch(`${this.apiUrl}/v1/account/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    if (verified.status !== 200) throw new Error(`verify ${email}: ${verified.status}`);
    const login = await fetch(`${this.apiUrl}/v1/account/login`, { method: "POST", ...json({ email, password }), headers: { "content-type": "application/json" } });
    if (login.status !== 200) throw new Error(`login ${email}: ${login.status}`);
    const cookie = (/__Host-renox_session=([^;]+)/u.exec(login.headers.getSetCookie().join("\n"))?.[1] ?? "") as string;
    const session = { cookie, csrf: ((await login.json()) as { csrf: string }).csrf };
    const made = await fetch(`${this.apiUrl}/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `__Host-renox_session=${session.cookie}`, "x-renox-csrf": session.csrf },
      body: JSON.stringify({ name: "chaos", scopes: ["*"], expires_in_days: 1 }),
    });
    if (made.status !== 201) throw new Error(`token ${id}: ${made.status} ${await made.text()}`);
    const tok = ((await made.json()) as { token: string }).token;
    await fetch(`${this.apiUrl}/v1/apps`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ name: id }) });
    const { hash, tar } = artifact(join(this.root, `artifact-${id}`), id);
    const t: Tenant = { id, app: id, host: `${id}.${DOMAIN}`, token: tok, hash, tar };
    await this.deploy(t);
    this.tenants.push(t);
    return { t, session };
  }

  async deploy(t: Tenant): Promise<void> {
    const auth = { authorization: `Bearer ${t.token}` };
    const up = await fetch(`${this.apiUrl}/v1/apps/${t.app}/deployments`, { method: "POST", headers: { ...auth, "content-type": "application/x-tar", "x-renox-artifact-hash": t.hash }, body: new Uint8Array(t.tar) });
    if (up.status !== 201 && up.status !== 200) throw new Error(`upload ${t.app}: ${up.status} ${await up.text()}`);
    const act = await fetch(`${this.apiUrl}/v1/apps/${t.app}/activate`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ hash: t.hash }) });
    if (act.status !== 200) throw new Error(`activate ${t.app}: ${act.status} ${await act.text()}`);
  }

  /** One request to `t` on node `n`. */
  async hit(n: Node, t: Tenant, method: "GET" | "POST" = "GET", timeoutMs = 3000): Promise<Hit> {
    try {
      const r = await fetch(`http://127.0.0.1:${n.port}/api/hits`, { method, headers: { host: t.host, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      const text = await r.text();
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = null;
      }
      return { status: r.status, body, text };
    } catch (e) {
      return { status: 0, body: null, text: String(e) };
    }
  }

  /** The node that serves `t` now (its GET answers 200). */
  owner(t: Tenant, within = 30_000): Promise<Node> {
    return until(`the owner of ${t.id}`, within, async () => {
      for (const n of this.nodes) if (n.proc !== null && (await this.hit(n, t)).status === 200) return n;
      return null;
    });
  }

  /** The node the control plane routes `t` to (`getOpsTenant`), without a request that would warm it. */
  async ownerOf(t: Tenant): Promise<Node> {
    return until(`the route entry of ${t.id}`, 30_000, async () => {
      const r = await this.op("GET", `/v1/ops/tenants/${t.id}`);
      if (r.status !== 200) return null;
      const node = ((await r.json()) as { node_id: string | null }).node_id;
      return this.nodes.find((n) => n.node === node) ?? null;
    });
  }

  /**
   * `count` tenants, then a victim and a bystander: on different nodes when
   * the placement allows it (so a node fault has a tenant to spare), with
   * the rest grouped by node.
   */
  async place(count = 4): Promise<{ victim: Tenant; victimNode: Node; bystander: Tenant; bystanderNode: Node; byNode: Map<string, Tenant[]> }> {
    const byNode = new Map<string, Tenant[]>();
    // Rendezvous placement: add tenants until both nodes own one (at most 12).
    for (let i = 0; i < 12 && (i < count || byNode.size < 2); i++) {
      const t = await this.tenant(`t-chaos-${String.fromCharCode(97 + i)}`);
      const n = await this.ownerOf(t);
      byNode.set(n.node, [...(byNode.get(n.node) ?? []), t]);
    }
    const groups = [...byNode.entries()].sort((a, b) => b[1].length - a[1].length);
    const [vNode, vTenants] = groups[0] as [string, Tenant[]];
    const victim = vTenants[0] as Tenant;
    const other = groups[1];
    const bystander = other === undefined ? (vTenants[1] as Tenant) : (other[1][0] as Tenant);
    const victimNode = this.nodes.find((n) => n.node === vNode) as Node;
    const bystanderNode = other === undefined ? victimNode : (this.nodes.find((n) => n.node === other[0]) as Node);
    return { victim, victimNode, bystander, bystanderNode, byNode };
  }

  /** The tenant's file on node `n` (`<data_dir>/<database>/app.db`; the database is the tenant id). */
  fileOf(n: Node, t: Tenant): string {
    return join(n.dataDir, t.id, "app.db");
  }

  /** `getBackups` of the tenant's app (it also records the node's report for /v1/ops/metrics). */
  async backups(t: Tenant): Promise<Record<string, unknown>> {
    const r = await fetch(`${this.apiUrl}/v1/apps/${t.app}/backups`, { headers: { authorization: `Bearer ${t.token}` } });
    return (await r.json()) as Record<string, unknown>;
  }

  /** The control plane's metric families (ops/observability), or null when it does not answer. */
  async metrics(): Promise<Map<string, number> | null> {
    try {
      const r = await fetch(`${this.apiUrl}/v1/ops/metrics`, { headers: { authorization: `Bearer ${this.operator}` }, signal: AbortSignal.timeout(3000) });
      if (r.status !== 200) return null;
      const out = new Map<string, number>();
      for (const line of (await r.text()).split("\n")) {
        if (line.startsWith("#") || line.trim() === "") continue;
        const i = line.lastIndexOf(" ");
        out.set(line.slice(0, i), Number(line.slice(i + 1)));
      }
      return out;
    } catch {
      return null;
    }
  }

  /** The worker's /healthz body, or null. */
  async health(n: Node): Promise<{ status: string; reasons?: string[] } | null> {
    try {
      return (await (await fetch(`http://127.0.0.1:${n.health}/healthz`, { signal: AbortSignal.timeout(2000) })).json()) as { status: string; reasons?: string[] };
    } catch {
      return null;
    }
  }

  async stop(): Promise<void> {
    const procs = this.nodes.map((n) => n.proc).filter((p): p is Bun.Subprocess => p !== null);
    for (const n of this.nodes) this.killWorker(n, "SIGTERM");
    await Promise.race([Promise.all(procs.map((p) => p.exited)), Bun.sleep(10_000)]);
    for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    await Promise.all(procs.map((p) => p.exited));
    // A sidecar can outlive its worker for a moment (on a node, systemd stops
    // the whole unit); this stack's are found by their config path.
    spawnSync("pkill", ["-TERM", "-f", `litestream replicate -config ${this.root}/`]);
    await until("this stack's sidecars to exit", 10_000, async () =>
      spawnSync("pgrep", ["-f", `litestream replicate -config ${this.root}/`]).status === 1 ? true : null,
    ).catch(() => spawnSync("pkill", ["-KILL", "-f", `litestream replicate -config ${this.root}/`]));
    await this.stopApi();
    for (const m of this.mounts) spawnSync("umount", ["-l", m]);
  }

  /** Removes the stack's directory; a failed run keeps it for its logs. */
  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/**
 * Starts a stack, runs `fn`, stops the stack; removes its directory after a
 * pass or a skip, keeps it (named in the notes, or in the error) otherwise.
 */
export async function withStack<O extends { verdict: string; notes: string[] }>(worker: string, opts: StackOptions, fn: (s: Stack) => Promise<O>): Promise<O> {
  const s = await Stack.start(worker, opts);
  let outcome: O;
  try {
    outcome = await fn(s);
  } catch (e) {
    await s.stop();
    throw new Error(`${e instanceof Error ? e.message : String(e)} (logs kept in ${s.root})`);
  }
  await s.stop();
  if (outcome.verdict === "FAIL") outcome.notes.push(`Logs kept in ${s.root}.`);
  else s.cleanup();
  return outcome;
}

/** Requests `t` on `n` every `everyMs` until stopped, counting the statuses (0 = no answer). */
export class Probe {
  readonly statuses = new Map<number, number>();
  private running = true;
  private readonly done: Promise<void>;

  constructor(stack: Stack, n: Node, t: Tenant, method: "GET" | "POST" = "GET", everyMs = 100) {
    this.done = (async () => {
      while (this.running) {
        const r = await stack.hit(n, t, method);
        this.statuses.set(r.status, (this.statuses.get(r.status) ?? 0) + 1);
        await Bun.sleep(everyMs);
      }
    })();
  }

  get total(): number {
    return [...this.statuses.values()].reduce((a, b) => a + b, 0);
  }

  get failures(): number {
    return this.total - (this.statuses.get(200) ?? 0);
  }

  summary(): string {
    return [...this.statuses.entries()].map(([s, n]) => `${n}×${s}`).join(", ") || "no requests";
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.done;
  }
}

/** The value of the first sample whose name starts with `prefix` (`name{labels…`), or null. */
export function sample(metrics: Map<string, number> | null, prefix: string): number | null {
  if (metrics === null) return null;
  for (const [k, v] of metrics) if (k === prefix || k.startsWith(prefix)) return v;
  return null;
}
