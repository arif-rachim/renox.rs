// #381: which worker has `ctx.pdf`. `renox dev` serves an app that renders
// the bilingual invoice of crates/renox-runtime/tests/pdf.rs (English and
// Arabic, a right-to-left block, a table) through `ctx.pdf.render`.
//
// Runs only when RENOX_WORKER_PDF says what the worker in RENOX_WORKER_PATH
// is, because a checkout build and the two release builds differ:
//   RENOX_WORKER_PDF=1  the worker has the PDF engine (the `-pdf` release
//                       variant, or a `cargo build` with default features):
//                       the response is a PDF;
//   RENOX_WORKER_PDF=0  the default release build (no `pdf` feature): the
//                       render fails with RENOX_INTERNAL, reason
//                       `pdf_unavailable`, and nothing else breaks.
// .github/workflows/release-worker.yml sets it for each variant it builds.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDev } from "../src/commands/dev.ts";
import { newApp } from "../src/commands/new.ts";
import { freePort } from "./free-port.ts";

const worker = process.env.RENOX_WORKER_PATH || undefined;
const expectPdf = process.env.RENOX_WORKER_PDF;

/** The invoice of crates/renox-runtime/tests/pdf.rs, as an app page. */
const INVOICE = `<!doctype html>
<html lang="en">
<body>
  <h1>Tax Invoice</h1>
  <p>Hello Trading LLC — TRN 100123456700003</p>
  <div dir="rtl" lang="ar">
    <h2>فاتورة ضريبية</h2>
    <p>شركة هلا للتجارة</p>
  </div>
  <table>
    <tr><th>Item</th><th>Qty</th><th>Amount (AED)</th></tr>
    <tr><td>Starter plan</td><td>1</td><td>79.00</td></tr>
    <tr><td>VAT 5 %</td><td></td><td>3.95</td></tr>
    <tr><td><strong>Total</strong></td><td></td><td><strong>82.95</strong></td></tr>
  </table>
  <p>Thank you for your business.</p>
</body>
</html>
`;

const HANDLER = `import type { Ctx } from "@renoxium/sdk";

export async function GET(ctx: Ctx): Promise<Response> {
  try {
    const bytes = await ctx.pdf.render("pages/invoice", {}, { page: "A4" });
    return new Response(bytes as BodyInit, { headers: { "content-type": "application/pdf" } });
  } catch (e) {
    const err = e as { code?: string; details?: unknown };
    return Response.json({ code: err.code ?? null, details: err.details ?? null }, { status: 500 });
  }
}
`;

test.skipIf(!worker || (expectPdf !== "1" && expectPdf !== "0"))(
  `renox dev renders the bilingual invoice through ctx.pdf (RENOX_WORKER_PDF=${expectPdf})`,
  async () => {
    const dir = newApp("pdftest", "hello", mkdtempSync(join(tmpdir(), "renox-dev-pdf-")));
    writeFileSync(join(dir, "pages/invoice.html"), INVOICE);
    mkdirSync(join(dir, "functions/api"), { recursive: true });
    writeFileSync(join(dir, "functions/api/invoice.ts"), HANDLER);
    const port = freePort();
    const dev = await startDev({ project: dir, port, log: () => {} });
    try {
      const r = await fetch(`http://localhost:${port}/api/invoice`);
      if (expectPdf === "1") {
        const bytes = new Uint8Array(await r.arrayBuffer());
        expect(r.status).toBe(200);
        expect(r.headers.get("content-type")).toBe("application/pdf");
        expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
        console.log(`ctx.pdf: bilingual invoice ${bytes.length} bytes`);
      } else {
        expect(r.status).toBe(500);
        const body = (await r.json()) as { code: unknown; details: { reason?: unknown } | null };
        expect(body.code).toBe("RENOX_INTERNAL");
        expect(body.details?.reason).toBe("pdf_unavailable");
        // The rest of the app still serves.
        expect(await (await fetch(`http://localhost:${port}/api/hello`)).json()).toEqual({ ok: true });
      }
    } finally {
      await dev.stop();
    }
  },
  120_000,
);
