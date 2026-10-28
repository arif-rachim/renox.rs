// Upload hardening (#95): generated bombs sent through POST
// /v1/apps/{app}/deployments are rejected at the first violation, with
// RENOX_DEPLOY_REJECTED and the rule, before more than the cap is read.
// Proves docs/23-failure-modes.md section 3, "Tarball decompression bomb / too
// many files", and docs/24-threat-model.md section E, "Deploy API abuse (huge
// uploads, bombs)".
//
// The API extracts into memory and never writes an upload to disk, so the
// resource assertion is on what the extractor pulled from the body (an upper
// bound on what it held), and on the artifact store holding nothing.

import { afterEach, describe, expect, test } from "bun:test";
import { UPLOAD_LIMITS } from "@renox/artifact-validate";
import { absolutePath, allBombs, deepPath, device, dotDot, hardlink, highRatio, manyEntries, oversizedEntry, symlink, totalOverflow, type Bomb } from "@renox/artifact-validate/bombs";
import { SOURCEMAP_LIMITS } from "../src/deployments/extract.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, createApp_, type Harness, harness, tenant } from "./helpers.ts";

afterEach(assertScoped);
import { contentHash } from "@renox/artifact-validate";

const MiB = 1024 * 1024;
const HASH = "d".repeat(64);

async function setup(): Promise<{ h: Harness; token: string }> {
  const h = await harness();
  const token = await tenant(h, "t_hello");
  await createApp_(h, token, "hello");
  return { h, token };
}

const send = (h: Harness, token: string, bomb: Bomb, path = "/v1/apps/hello/deployments") =>
  h.request(path.endsWith("sourcemaps") ? "PUT" : "POST", path, {
    token,
    body: bomb.body(),
    headers: { "content-type": bomb.gzip ? "application/gzip" : "application/x-tar", "x-renox-artifact-hash": HASH },
  });

/** What the extractor may pull from a body before it must have stopped. */
const BOUND: Record<Bomb["rule"], number> = {
  T1: 64 * 1024,
  T3: 6 * MiB,
  T4: 64 * 1024,
  // Stopped at the header: at most the header plus the stream's read-ahead.
  T5: 1 * MiB,
  // The ratio is checked once 1 MiB is decompressed; CompressionStream reads ahead.
  T6: 16 * MiB,
  // Stopped at the header that crosses the cap, before that file's bytes.
  T2: UPLOAD_LIMITS.maxTotalBytes + 1 * MiB,
};

describe("generated bombs through the upload endpoint", () => {
  for (const make of [highRatio, manyEntries, deepPath, symlink, hardlink, device, absolutePath, dotDot, oversizedEntry, totalOverflow]) {
    const bomb = make();
    test(`${bomb.rule} ${bomb.name}: 422 RENOX_DEPLOY_REJECTED, stopped early, nothing stored`, async () => {
      const { h, token } = await setup();
      const res = await send(h, token, bomb);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; deployment: string; details: { rule: string; reason: string }[] } };
      expect(body.error.code).toBe("RENOX_DEPLOY_REJECTED");
      expect(body.error.deployment).toBe(HASH);
      expect(body.error.details.map((d) => d.rule)).toEqual([bomb.rule]);
      expect(bomb.produced()).toBeLessThanOrEqual(BOUND[bomb.rule]);
      if (bomb.streamed) expect(bomb.produced()).toBeLessThan(bomb.fullSize);
      expect([...h.store.objects.keys()]).toEqual([]);
      const state = await h.db.query<{ state: string }>("select state from deployments where hash = $1", [HASH]);
      expect(state.map((r) => r.state)).toEqual(["rejected"]);
    }, 60_000);
  }

  test("the suite covers every rule a body can break while it is read (T1-T6)", () => {
    expect(new Set(allBombs().map((b) => b.rule))).toEqual(new Set(["T1", "T2", "T3", "T4", "T5", "T6"]));
  });

  test("a valid artifact still uploads after a rejected bomb with the same app", async () => {
    const { h, token } = await setup();
    expect((await send(h, token, symlink())).status).toBe(422);
    const files = helloArtifact();
    expect((await upload(h, token, "hello", files)).status).toBe(201);
    expect(h.store.objects.has(`artifacts/${contentHash(files)}.tar`)).toBe(true);
  });
});

describe("sourcemap uploads take the same rules with their own caps", () => {
  test("a high-ratio bomb is 422 RENOX_VALIDATION with T6 and is not stored", async () => {
    const { h, token } = await setup();
    const files = helloArtifact();
    const hash = contentHash(files);
    expect((await upload(h, token, "hello", files)).status).toBe(201);
    const bomb = highRatio();
    const res = await send(h, token, bomb, `/v1/apps/hello/deployments/${hash}/sourcemaps`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; details: { reason: string }[] } };
    expect(body.error.code).toBe("RENOX_VALIDATION");
    expect(body.error.details[0]?.reason).toStartWith("T6:");
    expect(bomb.produced()).toBeLessThanOrEqual(BOUND.T6);
    expect([...h.store.objects.keys()].filter((k) => k.startsWith("sourcemaps/"))).toEqual([]);
    expect(SOURCEMAP_LIMITS.maxTotalBytes).toBe(50 * MiB);
  }, 60_000);
});
