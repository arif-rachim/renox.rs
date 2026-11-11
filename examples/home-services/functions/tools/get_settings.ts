// App MCP tool `get_settings` (the owner connector, docs/20-ai-agents-mcp.md
// section 1b): the company's branding settings, as /admin/settings shows them:
// the names, the colour, the sender, the accounts email, the three footers and
// whether there is a logo (and where it loads from). Read only, `settings.read`
// like the page. It shows no secret: the setup's hash and key are not settings
// it reads.
import { tool } from "@renoxium/sdk";

import { NO_INPUT, noProperties, settingsView } from "../../lib/owner-tools";
import { inputOf } from "../../lib/tool-input";

export default tool({
  name: "get_settings",
  description: "The company's settings: brand name, brand colour, sender name, accounts email, footers and the logo",
  input: inputOf<Record<string, never>>(NO_INPUT, noProperties),
  action: "settings.read",
  async run(ctx) {
    return settingsView(ctx.db);
  },
});
