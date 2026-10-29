// End to end (#59): add -> TXT verification -> certificate from an ACME
// server -> the gateway serves the right certificate by SNI; an unverified
// hostname is 404 at the gateway (docs/23-failure-modes.md "Unverified
// custom domain").
//
// Real parts: the control API (in process) with its DNS resolver and ACME
// client; Pebble (Let's Encrypt's ACME test server) and pebble-challtestsrv
// as the local DNS server; two renox-worker processes, one with TLS (#162)
// whose `:80` listener answers the HTTP-01 challenge from `acme_dir`, and
// one plain to read the route table. The test plays the node's control
// client (#55): it writes the route snapshot and the certificate bundles
// into the workers' files and sends SIGHUP.
//
// Needs RENOX_PEBBLE_DIR (a directory with `pebble` and
// `pebble-challtestsrv`, src/domains/README.md) and RENOX_WORKER_PATH;
// skipped without them.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, writeFileSync } from "node:fs";
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
  test("add -> verify -> certificate issued -> served by SNI; unverified hostname is 404", async () => {
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
    const config = (name: string, listen: number, tls: string): string => {
      const text = `listen = "127.0.0.1:${listen}"\ndata_dir = "data-${name}"\nartifacts_dir = "artifacts"\nroutes_file = "routes.json"\nmeters_dir = "meters-${name}"\nlogs_dir = "logs-${name}"\n${tls}`;
      writeFileSync(join(root, `${name}.toml`), text);
      return join(root, `${name}.toml`);
    };
    const tlsWorker = spawn([WORKER as string, "--config", config("tls", tlsPort, `\n[tls]\ncert_dir = "certs"\nhttp_listen = "127.0.0.1:${httpPort}"\nacme_dir = "acme"\n`)]);
    const plainWorker = spawn([WORKER as string, "--config", config("plain", plainPort, "")]);
    for (const [what, port] of [["DNS", dnsMgmt], ["Pebble", acmePort], ["TLS worker", tlsPort], ["ACME listener", httpPort], ["plain worker", plainPort]] as const) await waitFor(what, tcpOpen(port));

    // The control plane.
    const h = await harness();
    const token = await tenant(h, "t_shop", "paid");
    await createApp_(h, token, "hello");
    const node = await registeredNode(h, "node-1");
    expect((await upload(h, token, "hello", hello)).status).toBe(201);
    expect((await h.request("POST", "/v1/apps/hello/activate", { token, json: { hash } })).status).toBe(200);
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
    // What the node's control client does: route snapshot to the route file, bundles to cert_dir, SIGHUP.
    const syncNode = async (): Promise<void> => {
      const snap = (await (await h.request("GET", "/v1/nodes/node-1/routes", { token: node })).json()) as RouteSnapshot;
      writeRoutes(snap.entries.map((e) => ({ hostname: e.hostname, tenant_id: e.tenant_id, deployment_hash: e.deployment_hash, status: e.status, updated_at: e.updated_at })));
      for (const e of snap.entries) {
        const res = await h.request("GET", `/v1/nodes/node-1/certificates/${e.hostname}`, { token: node });
        if (res.status !== 200) continue;
        const b = (await res.json()) as { chain_pem: string; key_pem: string };
        const dir = join(root, "certs", e.hostname);
        mkdirSync(dir, { recursive: true });
        for (const [name, pem] of [["fullchain.pem", b.chain_pem], ["privkey.pem", b.key_pem]] as const) {
          writeFileSync(join(dir, `.${name}.tmp`), pem, { mode: 0o600 });
          renameSync(join(dir, `.${name}.tmp`), join(dir, name));
        }
      }
      for (const w of [tlsWorker, plainWorker]) w.kill("SIGHUP");
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
    // The TLS worker presents the issued certificate for the SNI name; it chains to Pebble's root.
    const pebbleRoot = await (await fetch(`https://127.0.0.1:${acmeMgmt}/roots/0`, { tls: { ca: [pebbleCa] } } as RequestInit)).text();
    const r = await https(tlsPort, "www.shop.test", "www.shop.test", "/api/hello", pebbleRoot);
    expect(r.san).toBe("DNS:www.shop.test");
    expect(r.authorized).toBe(true);
    expect(r.status).toBe(200);
    // No certificate for the pending hostname: the handshake is refused.
    await expect(https(tlsPort, "pending.shop.test", "pending.shop.test", "/", pebbleRoot)).rejects.toThrow();
  }, 120_000);
});
