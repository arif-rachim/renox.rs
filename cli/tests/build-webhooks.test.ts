// #323: `renox build` of artifact 1.4: `functions/webhooks/*.ts` become
// `webhook` routes (POST only, the provider from `export const provider`),
// `renox.toml [storage]` and `[ai]` go on the manifest.

import { expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { buildFiles } from "../src/lib/build.ts";
import { app } from "./authz-fixture.ts";

const TOML = `[app]
name = "hooks"
timezone = "Asia/Dubai"

[permissions]
network = []
secrets = ["WEBHOOK_STRIPE_SECRET"]

[storage]
allowed_types = ["image/jpeg", "application/pdf"]
images = { widths = [320, 640] }

[ai]
mode = "gateway"
`;

async function build(files: Record<string, string>) {
  const dir = app(files);
  try {
    return await buildFiles(dir).catch((e: unknown) => e as Error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a webhook file is a webhook route with its provider; [storage] and [ai] are carried", async () => {
  const r = await build({
    "renox.toml": TOML,
    "functions/webhooks/stripe.ts": `export const provider = "stripe";\nexport async function POST(ctx) { const e = await ctx.webhook.verify(ctx.req, { provider }); return Response.json({ id: e.event_id }); }\n`,
  });
  if (r instanceof Error) throw r;
  const m = r.manifest as unknown as Record<string, unknown> & { routes: Record<string, unknown>[] };
  expect(m.routes).toContainEqual({ kind: "webhook", path: "/webhooks/stripe", module: "functions/webhooks/stripe", export: "POST", provider: "stripe" });
  expect(m.storage).toEqual({ allowed_types: ["image/jpeg", "application/pdf"], images: { widths: [320, 640] } });
  expect(m.ai).toEqual({ mode: "gateway" });
});

test("a webhook exporting GET, or an unknown provider, does not build", async () => {
  const get = await build({ "renox.toml": TOML, "functions/webhooks/x.ts": "export function GET() {}\nexport function POST() {}\n" });
  expect(String(get)).toContain("exports POST only");
  const p = await build({ "renox.toml": TOML, "functions/webhooks/x.ts": `export const provider = "paypal";\nexport function POST() {}\n` });
  expect(String(p)).toContain('provider "paypal"');
});
