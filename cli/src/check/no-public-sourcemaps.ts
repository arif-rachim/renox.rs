// `renox check` rule: no source map under public/ (#128). Everything in
// public/ is served from the app's origin, so a `.map` there would hand the
// TypeScript sources to every visitor. Source maps are uploaded privately by
// `renox deploy` from `.renox/sourcemaps/<hash>/` and used only to
// symbolicate browser errors in the dashboard (docs/contracts/deploy-api.md
// section 4, "Sourcemaps"; section 11.1).

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Finding } from "../lib/lint.ts";

const HINT = "keep source maps out of public/: `renox deploy` uploads them privately from .renox/sourcemaps/<hash>/";

/** One error per `*.map` file under `<project>/public/`. Symbolic links are not followed. */
export function noPublicSourcemaps(project: string): Finding[] {
  const root = join(project, "public");
  const out: Finding[] = [];
  const walk = (rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(join(root, rel)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(join(root, path));
      if (st.isDirectory()) walk(path);
      else if (st.isFile() && name.endsWith(".map")) {
        out.push({ file: `public/${path}`, line: 1, column: 1, rule: "public-sourcemap", severity: "error", message: `source map under public/ would be served to every visitor; ${HINT}` });
      }
    }
  };
  walk("");
  return out;
}
