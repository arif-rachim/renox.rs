// Control API listeners on loopback only (#366 scope 2). On the single host
// the public listener is reached only through `cloudflared` on loopback; the
// start-up check refuses a non-loopback listen address while every trusted
// proxy is on loopback, so a forged `CF-Connecting-IP` can never arrive from
// outside (docs/24-threat-model.md: "Login brute force, credential stuffing,
// enumeration"; "Bot signups").

import { describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { checkListen, ConfigError, isLoopbackHost, loadConfig } from "../src/config.ts";

const MAIN = `${import.meta.dir}/../src/main.ts`;
const PASSWORD = "correct horse battery staple";

const freePort = (): number => {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = s.port as number;
  s.stop(true);
  return port;
};

describe("the listen check", () => {
  test("loopback hosts", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "::", "10.0.0.5", "203.0.113.1", "example.com"]) expect(isLoopbackHost(h)).toBe(false);
  });

  test("default: 0.0.0.0 with no trusted proxy, as before #366", () => {
    expect(loadConfig({}).listenHost).toBe("0.0.0.0");
  });

  test("loopback-only proxies refuse a public listen address and accept a loopback one", () => {
    expect(() => loadConfig({ CONTROL_TRUSTED_PROXIES: "127.0.0.1,::1" })).toThrow(ConfigError);
    expect(() => loadConfig({ CONTROL_TRUSTED_PROXIES: "127.0.0.1,::1", CONTROL_LISTEN_HOST: "::" })).toThrow(ConfigError);
    expect(() => loadConfig({ CONTROL_TRUSTED_PROXIES: "127.0.0.1", CONTROL_LISTEN_HOST: "10.0.0.5" })).toThrow(ConfigError);
    expect(loadConfig({ CONTROL_TRUSTED_PROXIES: "127.0.0.1,::1", CONTROL_LISTEN_HOST: "127.0.0.1" }).listenHost).toBe("127.0.0.1");
    expect(() => checkListen("::1", ["::1"])).not.toThrow();
  });

  test("a proxy off the host (another address) does not force loopback", () => {
    expect(() => checkListen("0.0.0.0", ["10.0.0.0/8"])).not.toThrow();
    expect(() => loadConfig({ CONTROL_LISTEN_HOST: "" })).toThrow(ConfigError);
  });
});

describe("main.ts", () => {
  test("refuses to start with a public listener behind loopback-only proxies", async () => {
    const proc = Bun.spawn(["bun", MAIN], {
      env: { ...process.env, CONTROL_DATABASE_URL: "pglite:memory", CONTROL_LISTEN_PORT: String(freePort()), CONTROL_NODE_LISTEN_HOST: "127.0.0.1", CONTROL_NODE_LISTEN_PORT: String(freePort()), CONTROL_TRUSTED_PROXIES: "127.0.0.1,::1", CONTROL_LISTEN_HOST: "0.0.0.0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    // 78 (EX_CONFIG): renox-control.service does not restart on it.
    expect(await proc.exited).toBe(78);
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    expect(out).toContain("CONTROL_LISTEN_HOST");
  }, 30_000);

  test("on loopback behind the tunnel: not reachable on another address; the sign-up bucket keys on CF-Connecting-IP", async () => {
    const [port, nodePort] = [freePort(), freePort()];
    const proc = Bun.spawn(["bun", MAIN], {
      env: {
        ...process.env,
        CONTROL_DATABASE_URL: "pglite:memory",
        CONTROL_LISTEN_HOST: "127.0.0.1",
        CONTROL_LISTEN_PORT: String(port),
        CONTROL_NODE_LISTEN_HOST: "127.0.0.1",
        CONTROL_NODE_LISTEN_PORT: String(nodePort),
        CONTROL_TRUSTED_PROXIES: "127.0.0.1,::1",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const deadline = Date.now() + 30_000;
      while (!(await fetch(`http://127.0.0.1:${port}/v1/healthz`).then((r) => r.ok, () => false))) {
        if (Date.now() > deadline) throw new Error("main.ts did not start");
        await Bun.sleep(100);
      }
      // Another address of this host does not answer.
      const external = Object.values(networkInterfaces()).flat().find((i) => i !== undefined && !i.internal && i.family === "IPv4");
      if (external !== undefined) {
        const reached = await fetch(`http://${external.address}:${port}/v1/healthz`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
        expect(reached).toBe(false);
      }
      const signup = (client: string, i: number) =>
        fetch(`http://127.0.0.1:${port}/v1/account/signup`, {
          method: "POST",
          headers: { "content-type": "application/json", "CF-Connecting-IP": client },
          body: JSON.stringify({ email: `l${i}@example.ae`, password: PASSWORD, tenant_id: `t-l-${i}`, dpa_accepted: true }),
        }).then((r) => r.status);
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push(await signup("203.0.113.50", i));
      expect(statuses).toEqual([202, 202, 202, 429]);
      expect(await signup("198.51.100.51", 9)).toBe(202);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 60_000);
});
