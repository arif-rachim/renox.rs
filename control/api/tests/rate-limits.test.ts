// Per-token rate limits on the deploy API (#275 item 7; deploy-api.md
// section 2, proposed numbers: 20 requests/s with a burst of 100 per token,
// 10 uploads per minute; docs/24-threat-model.md E, "Deploy API abuse").

import { afterEach, describe, expect, test } from "bun:test";
import { RULES } from "../src/auth/buckets.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, createApp_, harness, scopedToken, tenant } from "./helpers.ts";

afterEach(assertScoped);

const codeOf = async (res: Response): Promise<string> => ((await res.json()) as { error: { code: string } }).error.code;

describe("per-token rate limits", () => {
  test("the numbers are the proposed ones of deploy-api.md section 2", () => {
    expect(RULES.token).toEqual({ burst: 100, everySeconds: 0.05 });
    expect(RULES.tokenUpload).toEqual({ burst: 10, everySeconds: 6 });
  });

  test("past the burst of 100 a token gets 429 RENOX_RATE_LIMITED with Retry-After; another token is unaffected; it refills at 20/s", async () => {
    const h = await harness();
    const owner = await tenant(h, "t_a");
    const other = await scopedToken(h, "t_a", ["apps:read"]);
    for (let i = 0; i < 100; i++) expect((await h.request("GET", "/v1/apps", { token: owner })).status).toBe(200);
    const over = await h.request("GET", "/v1/apps", { token: owner });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("1");
    expect(await codeOf(over)).toBe("RENOX_RATE_LIMITED");
    // The bucket is per token, not per tenant.
    expect((await h.request("GET", "/v1/apps", { token: other })).status).toBe(200);
    // 50 ms earns one request back.
    h.clock.now += 50;
    expect((await h.request("GET", "/v1/apps", { token: owner })).status).toBe(200);
    expect((await h.request("GET", "/v1/apps", { token: owner })).status).toBe(429);
  });

  test("the 11th upload within a minute is 429; a minute later uploads work again", async () => {
    const h = await harness();
    const owner = await tenant(h, "t_a");
    await createApp_(h, owner, "hello");
    const files = helloArtifact();
    for (let i = 0; i < 10; i++) expect((await upload(h, owner, "hello", files)).status).toBeLessThan(300);
    const over = await upload(h, owner, "hello", files);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await codeOf(over)).toBe("RENOX_RATE_LIMITED");
    // Reads are not uploads: still within the general bucket.
    expect((await h.request("GET", "/v1/apps", { token: owner })).status).toBe(200);
    h.clock.now += 60_000;
    expect((await upload(h, owner, "hello", files)).status).toBeLessThan(300);
  });
});
