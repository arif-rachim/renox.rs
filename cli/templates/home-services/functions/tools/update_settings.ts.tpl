// App MCP tool `update_settings` (the owner connector, docs/20-ai-agents-mcp.md
// section 1b): changes the branding settings the way /admin/settings saves them
// (lib/admin.ts saveSettings, with its audit row of the keys changed): the
// brand name, the #RRGGBB colour, the sender name, the accounts email and the
// invoice, quotation and job card footers.
//
// The action is `settings.update`, not the page's `settings.write`: that one is
// sensitive (policies/app/base.cedar forbids it without `mfa_verified`) and an
// agent token is never MFA verified (docs/20-ai-agents-mcp.md section 2), so
// the owner's agent could never pass it. `settings.update` has no forbid: the
// owner's blanket permit alone grants it (a branch manager, a dispatcher, a
// technician and an accountant are refused), and the owner confirms in person
// (`confirm`): the first call only answers what would change.
import { tool } from "@renoxium/sdk";

import { parseSettingsPatch, patchEntries, SETTINGS_PATCH_JSON, settingsView, type SettingsPatch } from "../../lib/owner-tools";
import { inputOf } from "../../lib/tool-input";

export default tool({
  name: "update_settings",
  description: "Change the company's settings (brand name, brand colour, sender name, accounts email, footers); asks you to confirm first",
  input: inputOf<{ settings: SettingsPatch }>(SETTINGS_PATCH_JSON, parseSettingsPatch),
  action: "settings.update",
  confirm: true,
  async run(ctx) {
    const { saveSettings } = await import("../../lib/admin");
    const { getSettings } = await import("../../lib/settings");
    const { refuse } = await import("../../lib/tools");
    const issues: { message: string; path: string[] }[] = [];
    const patch = parseSettingsPatch(ctx.tool.input as Record<string, unknown>, issues).settings;
    if (issues.length > 0) return refuse("bad_input", issues.map((i) => i.message).join("; "));
    const next = patchEntries(patch);
    const current = await getSettings(ctx.db);
    if (ctx.tool.preview) {
      // Nothing is written on the first call; the plan names each key that changes, from its value now to its new one.
      const would_change = Object.entries(next).filter(([k, v]) => (current[k] ?? "") !== v).map(([key, to]) => ({ key, from: current[key] ?? "", to }));
      return { would_change };
    }
    await saveSettings(ctx, current, next);
    return settingsView(ctx.db);
  },
});
