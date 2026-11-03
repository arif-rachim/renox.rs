// End to end (#59): add -> TXT verification -> certificate from an ACME
// server -> the gateway serves the right certificate by SNI; an unverified
// hostname is 404 at the gateway (docs/23-failure-modes.md "Unverified
// custom domain").
//
// Real parts: the control API (in process, its node endpoints on a real
// listener) with its DNS resolver and ACME client; Pebble (Let's Encrypt's
// ACME test server) and pebble-challtestsrv as the local DNS server; two
// renox-worker processes. The TLS one (#162) is a controlled node (#55): its
// `:80` listener answers the HTTP-01 challenge from `acme_dir`, it follows
// the control stream, and on `certificate_update` it fetches the bundle,
// writes `cert_dir` and reloads its certificates itself (#391): nothing is
// written into its directory by the test and it gets no SIGHUP. The plain
// one reads a route file the test writes from the route snapshot.
//
// Needs RENOX_PEBBLE_DIR (a directory with `pebble` and
// `pebble-challtestsrv`, src/domains/README.md) and RENOX_WORKER_PATH;
// skipped without them.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { contentHash } from "@renox/artifact-validate";
import { AcmeClient } from "../src/domains/acme.ts";
import { accountStore } from "../src/domains/certs.ts";
import { DirChallengeResponder } from "../src/domains/challenges.ts";
import { SystemResolver } from "../src/domains/dns.ts";
import { tick } from "../src/domains/jobs.ts";
import { configureDomains } from "../src/domains/service.ts";
import { EnvMasterKey } from "../src/secrets/crypto.ts";
import type { RouteSnapshot } from "../src/routes/table.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, createApp_, harness, registeredNode, tenant } from "./helpers.ts";

afterEach(assertScoped);

const PEBBLE = process.env.RENOX_PEBBLE_DIR;
const WORKER = process.env.RENOX_WORKER_PATH;
const enabled = PEBBLE !== undefined && WORKER !== undefined && existsSync(join(PEBBLE, "pebble")) && existsSync(WORKER);

const procs: Bun.Subprocess[] = [];
afterAll(() => {
  for (const p of procs) p.kill();
});

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

async function waitFor(what: string, ok: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await ok().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

const tcpOpen = (port: number) => async (): Promise<boolean> =>
  new Promise((resolve) => {
    void Bun.connect({ hostname: "127.0.0.1", port, socket: { open: (s) => (s.end(), resolve(true)), connectError: () => resolve(false), data() {} } }).catch(() => resolve(false));
  });

function spawn(cmd: string[], env: Record<string, string> = {}): Bun.Subprocess {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore" });
  procs.push(p);
  return p;
}

/** One HTTPS request over a TLS connection with `sni`; the certificate the server chose and the status. */
function https(port: number, sni: string, host: string, path: string, ca: string): Promise<{ authorized: boolean; san: string; status: number }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, servername: sni, ca, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] }, () => {
      const san = socket.getPeerCertificate().subjectaltname ?? "";
      const authorized = socket.authorized;
      let buf = "";
      socket.on("data", (d: Buffer) => {
        buf += d.toString("latin1");
        const m = /^HTTP\/1\.1 ([0-9]{3})/u.exec(buf);
        if (m !== null) {
          socket.destroy();
          resolve({ authorized, san, status: Number(m[1]) });
        }
      });
      socket.write(`GET ${path} HTTP/1.1\r\nhost: ${host}\r\nconnection: close\r\n\r\n`);
    });
    socket.on("error", reject);
  });
}

async function plainStatus(port: number, host: string, path: string): Promise<number> {
  return (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { host } })).status;
}

describe.skipIf(!enabled)("custom domain end to end with Pebble and a TLS worker", () => {
  test("add -> verify -> certificate issued -> the controlled worker installs it and serves it by SNI; unverified hostname is 404", async () => {
    const root = mkdtempSync(join(tmpdir(), "renox-domains-e2e-"));
    const [dnsPort, dnsMgmt, acmePort, acmeMgmt, httpPort, tlsPort, plainPort] = (await Promise.all(Array.from({ length: 7 }, freePort))) as [number, number, number, number, number, number, number];

    // Pebble's own HTTPS certificate.
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", join(root, "pebble.key"), "-out", join(root, "pebble.crt")], { stdio: "ignore" });
    writeFileSync(
      join(root, "pebble.json"),
      JSON.stringify({ pebble: { listenAddress: `127.0.0.1:${acmePort}`, managementListenAddress: `127.0.0.1:${acmeMgmt}`, certificate: join(root, "pebble.crt"), privateKey: join(root, "pebble.key"), httpPort, tlsPort: await freePort(), ocspResponderURL: "", externalAccountBindingRequired: false } }),
    );
    spawn([join(PEBBLE as string, "pebble-challtestsrv"), "-dns01", `127.0.0.1:${dnsPort}`, "-management", `127.0.0.1:${dnsMgmt}`, "-http01", "", "-https01", "", "-tlsalpn01", "", "-doh", "", "-defaultIPv4", "127.0.0.1", "-defaultIPv6", ""]);
    spawn([join(PEBBLE as string, "pebble"), "-config", join(root, "pebble.json"), "-dnsserver", `127.0.0.1:${dnsPort}`], { PEBBLE_VA_NOSLEEP: "1", PEBBLE_WFE_NONCEREJECT: "0", PEBBLE_AUTHZREUSE: "0" });

    // Two workers on one route table: TLS (with the :80 ACME listener) and plain.
    const hello = helloArtifact();
    const hash = contentHash(hello);
    const examples = new URL("../../../docs/contracts/examples/hello-artifact/", import.meta.url).pathname;
    for (const d of ["certs", "acme", "artifacts"]) mkdirSync(join(root, d), { recursive: true });
    cpSync(join(examples, hash), join(root, "artifacts", hash), { recursive: true });
    const writeRoutes = (entries: unknown[]): void => {
      writeFileSync(join(root, ".routes.tmp"), JSON.stringify({ version: 0, entries }));
      renameSync(join(root, ".routes.tmp"), join(root, "routes.json"));
    };
    writeRoutes([]);
    const config = (name: string, listen: number, rest: string, routes = `routes_file = "routes.json"\n`): string => {
      const text = `listen = "127.0.0.1:${listen}"\ndata_dir = "data-${name}"\nartifacts_dir = "artifacts"\n${routes}meters_dir = "meters-${name}"\nlogs_dir = "logs-${name}"\n${rest}`;
      writeFileSync(join(root, `${name}.toml`), text);
      return join(root, `${name}.toml`);
    };
    const plainWorker = spawn([WORKER as string, "--config", config("plain", plainPort, "")]);

    // The control plane, its node endpoints on a real listener for the controlled worker.
    const h = await harness();
    const token = await tenant(h, "t_shop", "paid");
    await createApp_(h, token, "hello");
    const node = await registeredNode(h, "node-1");
    expect((await upload(h, token, "hello", hello)).status).toBe(201);
    expect((await h.request("POST", "/v1/apps/hello/activate", { token, json: { hash } })).status).toBe(200);
    const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, srv) => h.app.fetch(req, srv), idleTimeout: 0 });
    writeFileSync(join(root, "node.token"), node, { mode: 0o600 });
    spawn([
      WORKER as string,
      "--config",
      config(
        "tls",
        tlsPort,
        `node_id = "node-1"\nfetch_blocked_addresses = ["203.0.113.250"]\n[control]\nurl = "http://127.0.0.1:${api.port}"\nnode_token_file = "${join(root, "node.token")}"\n[sandbox]\nallow_unsandboxed = true\n[tls]\ncert_dir = "certs"\nhttp_listen = "127.0.0.1:${httpPort}"\nacme_dir = "acme"\n`,
        `mode = "controlled"\n`,
      ),
    ]);
    for (const [what, port] of [["DNS", dnsMgmt], ["Pebble", acmePort], ["TLS worker", tlsPort], ["ACME listener", httpPort], ["plain worker", plainPort]] as const) await waitFor(what, tcpOpen(port));
    const pebbleCa = await Bun.file(join(root, "pebble.crt")).text();
    const keys = new EnvMasterKey(Buffer.alloc(32, 9).toString("base64"));
    const directoryUrl = `https://127.0.0.1:${acmePort}/dir`;
    configureDomains(h.deps, {
      resolver: new SystemResolver([`127.0.0.1:${dnsPort}`]),
      issuer: new AcmeClient({ directoryUrl, ca: pebbleCa, pollMs: 200, timeoutMs: 30_000 }, accountStore(h.db, keys, directoryUrl, () => Date.now())),
      responder: new DirChallengeResponder(join(root, "acme")),
      edge: { hostname: "edge.renox.test", addresses: ["127.0.0.1"] },
      keys,
    });
    // The plain worker reads a route file: the snapshot is written there and the worker gets SIGHUP.
    // The controlled TLS worker needs nothing from the test.
    const syncNode = async (): Promise<void> => {
      const snap = (await (await h.request("GET", "/v1/nodes/node-1/routes", { token: node })).json()) as RouteSnapshot;
      writeRoutes(snap.entries.map((e) => ({ hostname: e.hostname, tenant_id: e.tenant_id, deployment_hash: e.deployment_hash, status: e.status, updated_at: e.updated_at })));
      plainWorker.kill("SIGHUP");
      await Bun.sleep(300);
    };

    const dnsApi = (path: string, body: unknown) => fetch(`http://127.0.0.1:${dnsMgmt}${path}`, { method: "POST", body: JSON.stringify(body) });
    const added = (await (await h.request("POST", "/v1/apps/hello/domains", { token, json: { hostname: "www.shop.test" } })).json()) as { verification: { record_name: string; record_value: string } };
    expect((await h.request("POST", "/v1/apps/hello/domains", { token, json: { hostname: "pending.shop.test" } })).status).toBe(201);

    // Before the TXT record: nothing is served for either hostname.
    await tick(h.deps);
    await syncNode();
    expect(await plainStatus(plainPort, "hello.renox.app", "/api/hello")).toBe(200);
    expect(await plainStatus(plainPort, "www.shop.test", "/api/hello")).toBe(404);

    expect((await dnsApi("/set-txt", { host: `${added.verification.record_name}.`, value: added.verification.record_value })).status).toBe(200);
    h.clock.now += 60_000;
    await tick(h.deps);
    const d = (await (await h.request("GET", "/v1/apps/hello/domains/www.shop.test", { token })).json()) as { state: string; dns: string; certificate: { state: string; not_after: number } };
    expect(d).toMatchObject({ state: "verified", dns: "ok", certificate: { state: "issued" } });
    expect(readdirSync(join(root, "acme"))).toEqual([]);

    await syncNode();
    // The verified hostname is served, the pending one is still 404.
    expect(await plainStatus(plainPort, "www.shop.test", "/api/hello")).toBe(200);
    expect(await plainStatus(plainPort, "pending.shop.test", "/api/hello")).toBe(404);
    // The controlled TLS worker got certificate_update on its stream, fetched the bundle with its
    // node token, wrote cert_dir and reloaded (#391): it serves the custom hostname over TLS with the
    // issued certificate, which chains to Pebble's root.
    const pebbleRoot = await (await fetch(`https://127.0.0.1:${acmeMgmt}/roots/0`, { tls: { ca: [pebbleCa] } } as RequestInit)).text();
    let r: { authorized: boolean; san: string; status: number } | undefined;
    await waitFor("the worker to serve www.shop.test over TLS", async () => {
      r = await https(tlsPort, "www.shop.test", "www.shop.test", "/api/hello", pebbleRoot);
      return r.status === 200;
    });
    expect(r).toMatchObject({ san: "DNS:www.shop.test", authorized: true, status: 200 });
    // Written by the worker in the renew-wildcard-cert.sh layout, marked as the control plane's.
    expect(existsSync(join(root, "certs", "www.shop.test", "fullchain.pem"))).toBe(true);
    expect(existsSync(join(root, "certs", "www.shop.test", "privkey.pem"))).toBe(true);
    expect(readFileSync(join(root, "certs", "www.shop.test", ".renox-control"), "utf8")).toMatch(/^[0-9]+$/u);
    // No certificate for the pending hostname: the handshake is refused.
    await expect(https(tlsPort, "pending.shop.test", "pending.shop.test", "/", pebbleRoot)).rejects.toThrow();
    // Detach: certificate_remove reaches the worker, the handshake for the hostname is refused again.
    expect((await h.request("DELETE", "/v1/apps/hello/domains/www.shop.test", { token })).status).toBeLessThan(300);
    await waitFor("the worker to drop www.shop.test", async () => {
      try {
        await https(tlsPort, "www.shop.test", "www.shop.test", "/", pebbleRoot);
        return false;
      } catch {
        return true;
      }
    });
    api.stop(true);
  }, 120_000);
});
