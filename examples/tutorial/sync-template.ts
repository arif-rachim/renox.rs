// bun examples/tutorial/sync-template.ts: writes cli/templates/tutorial/ from
// step-01, the one source of `renox new <name> --template tutorial` (#430).
// `cli/tests/tutorial.test.ts` fails when the two differ; run this, then
// commit both. The files `renox new` writes for every template (renox.toml,
// package.json, tsconfig.json, .gitignore and the agent files) are not
// copied: the test checks that step-01 holds exactly what `renox new` writes.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** step-01's own files, the template's. */
export const TEMPLATE_FILES = ["README.md", "functions/api/health.ts", "pages/_layouts/main.html", "pages/index.html", "tests/app.test.ts"] as const;

export const STEP_01 = join(import.meta.dir, "step-01");
export const TEMPLATE_DIR = join(import.meta.dir, "../../cli/templates/tutorial");

if (import.meta.main) {
  rmSync(TEMPLATE_DIR, { recursive: true, force: true });
  for (const rel of TEMPLATE_FILES) {
    const out = join(TEMPLATE_DIR, `${rel}.tpl`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, readFileSync(join(STEP_01, rel)));
  }
  console.log(`wrote ${TEMPLATE_FILES.length} files to cli/templates/tutorial/`);
}
