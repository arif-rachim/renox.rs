// App MCP tool `upload_logo` (the owner connector, docs/20-ai-agents-mcp.md
// section 1b): replaces the company's logo with the image sent as base64: at
// most 512 KiB decoded, a PNG, a JPEG or an SVG. What the bytes are is checked
// from the bytes (the magic bytes of a PNG and a JPEG, the root element of an
// SVG), not from the declared `content_type`, which must agree. A PNG or JPEG is
// stored like the branding page's logo (`ctx.storage`, public, under app/brand/);
// an SVG goes through the `storage` module, which sanitises it (the platform
// refuses an unsanitised SVG). `settings.update`, see update_settings.ts. The
// first call (`confirm`) checks the image and stores nothing: a file put in the
// object store is not undone by the rolled back transaction of a preview.
import { tool } from "@renoxium/sdk";

import { decodeBase64, LOGO_JSON, type LogoType, parseLogo, sniffLogo } from "../../lib/owner-tools";
import { inputOf } from "../../lib/tool-input";

export default tool({
  name: "upload_logo",
  description: "Replace the company's logo: a PNG, JPEG or SVG as base64, at most 512 KiB; asks you to confirm first",
  input: inputOf<{ image: string; content_type: LogoType }>(LOGO_JSON, parseLogo),
  action: "settings.update",
  confirm: true,
  async run(ctx) {
    const { saveSettings, storeLogo, storeSvgLogo } = await import("../../lib/admin");
    const { getSettings, logoSrc } = await import("../../lib/settings");
    const { refuse } = await import("../../lib/tools");
    const issues: { message: string; path: string[] }[] = [];
    const input = parseLogo(ctx.tool.input as Record<string, unknown>, issues);
    if (issues.length > 0) return refuse("bad_input", issues.map((i) => i.message).join("; "));
    const bytes = decodeBase64(input.image);
    const sniffed = sniffLogo(bytes);
    if (sniffed === null) return refuse("bad_input", "The image is not a PNG, a JPEG or an SVG.");
    if (sniffed !== input.content_type) return refuse("bad_input", `content_type says ${input.content_type} but the image is a ${sniffed}.`);
    if (ctx.tool.preview) return { would_replace: { content_type: sniffed, bytes: bytes.length } };
    const current = await getSettings(ctx.db);
    const previous = current.brand_logo_key ?? "";
    const stored = sniffed === "image/svg+xml" ? await storeSvgLogo(ctx.storage, bytes, previous) : await storeLogo(ctx.storage, { type: sniffed, bytes }, previous);
    if (!stored.ok) return refuse("bad_input", stored.error === "storage" ? "The platform's storage refused the image." : `The image is not accepted (${stored.error}).`);
    await saveSettings(ctx, current, { brand_logo_key: stored.key });
    return { logo_url: logoSrc({ brand_logo_key: stored.key }) };
  },
});
