// The `renox new` templates (cli/templates/<name>/; a `.tpl` file is written
// without the suffix), embedded so the compiled binary carries them. `hello`
// mirrors examples/hello. `COMMON` is written into every new app whatever
// the template: the agent files (#377; docs/12-developer-experience.md,
// "Build with an AI agent").

import agents from "../../templates/AGENTS.md.tpl" with { type: "text" };
import blankHealth from "../../templates/blank/functions/api/health.ts.tpl" with { type: "text" };
import claude from "../../templates/CLAUDE.md.tpl" with { type: "text" };
import helloHello from "../../templates/hello/functions/api/hello.ts.tpl" with { type: "text" };
import helloIndex from "../../templates/hello/pages/index.html.tpl" with { type: "text" };
import helloLayout from "../../templates/hello/pages/_layouts/main.html.tpl" with { type: "text" };
import helloTest from "../../templates/hello/tests/hello.test.ts.tpl" with { type: "text" };
import readme from "../../templates/README.md.tpl" with { type: "text" };
import mcp from "../../templates/mcp.json.tpl" with { type: "text" };
import tsconfig from "../../templates/tsconfig.json.tpl" with { type: "text" };

/** `{{APP}}` in a template is replaced by the app's name (#449). */
export const TEMPLATES = {
  blank: { "functions/api/health.ts": blankHealth },
  hello: {
    "functions/api/hello.ts": helloHello,
    "pages/index.html": helloIndex,
    "pages/_layouts/main.html": helloLayout,
    "tests/hello.test.ts": helloTest,
  },
} as const satisfies Record<string, Record<string, string>>;

export type TemplateName = keyof typeof TEMPLATES;

export const TSCONFIG = tsconfig as string;

/**
 * Files every new app gets: `README.md` (how to run, test and deploy it,
 * #449), `AGENTS.md` (the app model, the commands and the
 * rules in short, for any coding agent), `CLAUDE.md` (points at it) and
 * `.mcp.json` (registers `renox mcp --project .`, which Claude Code reads as
 * is and Cursor reads from `.cursor/mcp.json`).
 */
export const COMMON: Readonly<Record<string, string>> = {
  "README.md": readme as string,
  "AGENTS.md": agents as string,
  "CLAUDE.md": claude as string,
  ".mcp.json": mcp as string,
};
