// The `renox new` templates (cli/templates/<name>/; a `.tpl` file is written
// without the suffix), embedded so the compiled binary carries them. `hello`
// mirrors examples/hello.

import blankHealth from "../../templates/blank/functions/api/health.ts.tpl" with { type: "text" };
import helloHello from "../../templates/hello/functions/api/hello.ts.tpl" with { type: "text" };
import tsconfig from "../../templates/tsconfig.json.tpl" with { type: "text" };

export const TEMPLATES = {
  blank: { "functions/api/health.ts": blankHealth },
  hello: { "functions/api/hello.ts": helloHello },
} as const satisfies Record<string, Record<string, string>>;

export type TemplateName = keyof typeof TEMPLATES;

export const TSCONFIG = tsconfig as string;
