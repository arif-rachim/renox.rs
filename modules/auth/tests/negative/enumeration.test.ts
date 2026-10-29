// docs/24-threat-model.md F4, "Login brute force, credential stuffing,
// enumeration"; docs/23-failure-modes.md section 5: login, register, reset
// and magic-link responses are the same for an email with an account and
// one without, and take about as long (within 20 %).

import { describe, expect, test } from "bun:test";

import { account, authCookie, messageOf, PASSWORD, start, timed, worker } from "./helpers.ts";

const t = await start();

describe.skipIf(!worker)("no user enumeration", () => {
  test("register: the same answer, no cookie, for a taken and a new email", async () => {
    await account(t, "owner", "taken@example.com");
    const taken = await t.as("probe-1").action("/auth/register", "default", { email: "taken@example.com", password: PASSWORD });
    const fresh = await t.as("probe-2").action("/auth/register", "default", { email: "fresh@example.com", password: PASSWORD });
    expect(taken.status).toBe(fresh.status);
    expect(messageOf(taken.html)).toBe(messageOf(fresh.html));
    expect(authCookie(taken)).toBeUndefined();
    expect(authCookie(fresh)).toBeUndefined();
  });

  test("login, reset and magic link: the same answers", async () => {
    const pairs: [string, Record<string, string>][] = [
      ["/auth/login", { password: "wrong password!" }],
      ["/auth/reset", {}],
      ["/auth/magic", {}],
    ];
    for (const [path, extra] of pairs) {
      const known = await t.as(`k${path}`).action(path, "default", { email: "taken@example.com", ...extra });
      const unknown = await t.as(`u${path}`).action(path, "default", { email: "nobody-here@example.com", ...extra });
      expect([path, known.status, messageOf(known.html)]).toEqual([path, unknown.status, messageOf(unknown.html)]);
    }
  });

  test("timing: an existing and a missing account answer within 20 % of each other", async () => {
    const ratio = (a: number, b: number) => Math.max(a, b) / Math.min(a, b);
    const login = (email: string) => (i: number) => t.as(`tl-${email}-${i}`).action("/auth/login", "default", { email, password: `wrong ${i} password` });
    const loginKnown = await timed(7, login("taken@example.com"));
    const loginUnknown = await timed(7, login("missing@example.com"));
    expect(ratio(loginKnown, loginUnknown)).toBeLessThan(1.2);
    const reg = (email: (i: number) => string) => (i: number) => t.as(`tr-${i}-${email(i)}`).action("/auth/register", "default", { email: email(i), password: PASSWORD });
    const regTaken = await timed(5, reg(() => "taken@example.com"));
    const regNew = await timed(5, reg((i) => `new-${i}@example.com`));
    expect(ratio(regTaken, regNew)).toBeLessThan(1.2);
  }, 60_000);
});
