// CI check for issue #701: a workflow never prints a secret.
// Usage: bun .github/scripts/workflow-secrets.ts [workflows-dir]   (default .github/workflows)
//
// Rules (exit 1, `file:line: rule: message`):
//   set-x   set -x / set -o xtrace / bash -x in a step whose env (step, job or workflow level)
//           holds a ${{ secrets.* }} expression; also in a script that step runs from the repository.
//   echo    echo / printf / cat <<EOF of a ${{ secrets.* }} expression or of an environment
//           variable the step maps from one (output that is piped or redirected is not printed).
//   inline  ${{ secrets.* }} inside run: text; it must come through env:.
// Out of scope: ::add-mask:: for derived values (no workflow mints a token in a step today).
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const SECRET = /\$\{\{\s*secrets\.[^}]*\}\}/;
const XTRACE =
  /(?:\bset\s+(?:-[a-zA-Z]*x[a-zA-Z]*|(?:-[a-zA-Z]+\s+)*-o\s+xtrace)\b|\b(?:ba|da|z)?sh\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*x[a-zA-Z]*\b)/;

export type Finding = { file: string; line: number; rule: "set-x" | "echo" | "inline"; message: string };
type Env = Record<string, unknown>;
type Step = { run?: string; env?: Env };
type Job = { env?: Env; steps?: Step[] };

function secretNames(...envs: (Env | undefined)[]): string[] {
  const names: string[] = [];
  for (const env of envs) {
    for (const [k, v] of Object.entries(env ?? {})) if (typeof v === "string" && SECRET.test(v)) names.push(k);
  }
  return names;
}

function mentions(text: string, names: string[]): boolean {
  if (SECRET.test(text)) return true;
  return names.some((n) => new RegExp(`\\$\\{?${n}\\b`).test(text));
}

// A line prints when it is an echo/printf whose output is neither piped nor redirected.
function printsSecret(lines: string[], names: string[]): number[] {
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const code = (lines[i] ?? "").trim();
    if (code.startsWith("#")) continue;
    const unquoted = code.replace(/"[^"]*"|'[^']*'/g, '""');
    if (/^(?:echo|printf)\b/.test(code)) {
      if (mentions(code, names) && !/[|>]/.test(unquoted)) hits.push(i);
    } else if (/^cat\s+<<-?\s*['"]?\w+['"]?/.test(code) && !/[|>]/.test(unquoted.replace(/<<-?\s*\S+/, ""))) {
      const delim = /<<-?\s*['"]?(\w+)['"]?/.exec(code)?.[1] ?? "";
      for (let j = i + 1; j < lines.length && (lines[j] ?? "").trim() !== delim; j++) {
        if (mentions(lines[j] ?? "", names)) {
          hits.push(j);
          break;
        }
      }
    }
  }
  return hits;
}

function referencedScripts(run: string, dir: string): string[] {
  const found: string[] = [];
  for (const m of run.matchAll(/[\w.\/-]+\.(?:sh|ts)\b/g)) {
    for (const base of [root, dir]) {
      const p = resolve(base, m[0]);
      if (existsSync(p) && !found.includes(p)) found.push(p);
    }
  }
  return found;
}

export function checkDir(dir: string): Finding[] {
  const findings: Finding[] = [];
  const shown = (p: string) => (p.startsWith(root + "/") ? p.slice(root.length + 1) : p);
  const files = [...new Bun.Glob("*.{yml,yaml}").scanSync({ cwd: dir })].sort();
  for (const name of files) {
    const path = join(dir, name);
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    const doc = Bun.YAML.parse(text) as { env?: Env; jobs?: Record<string, Job> };
    let cursor = 0;
    const add = (line: number, rule: Finding["rule"], message: string, file = shown(path)) =>
      findings.push({ file, line, rule, message });

    for (const job of Object.values(doc.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (typeof step.run !== "string") continue;
        // Locate the step's run text in the file (steps are visited in document order).
        const runLines = step.run.split("\n");
        const first = Math.max(
          runLines.findIndex((l) => l.trim() !== ""),
          0,
        );
        const needle = (runLines[first] ?? "").trim();
        let start = cursor;
        for (let i = cursor; i < lines.length; i++) {
          if ((lines[i] ?? "").includes(needle)) {
            start = i - first;
            break;
          }
        }
        cursor = Math.max(cursor, start + runLines.length - 1);
        const at = (i: number) => start + i + 1;

        const names = secretNames(doc.env, job.env, step.env);
        runLines.forEach((l, i) => {
          if (SECRET.test(l)) add(at(i), "inline", "${{ secrets.* }} inside run: text; pass it through env: instead");
          if (names.length > 0 && XTRACE.test(l) && !l.trim().startsWith("#"))
            add(at(i), "set-x", `command tracing in a step whose env holds a secret (${names.join(", ")})`);
        });
        for (const i of printsSecret(runLines, names))
          add(at(i), "echo", "prints a secret or an environment variable mapped from one");

        if (names.length > 0) {
          for (const script of referencedScripts(step.run, dir)) {
            if (!script.endsWith(".sh")) continue;
            readFileSync(script, "utf8")
              .split("\n")
              .forEach((l, i) => {
                if (XTRACE.test(l) && !l.trim().startsWith("#"))
                  add(i + 1, "set-x", `command tracing in a script run by a step whose env holds a secret (${basename(path)})`, shown(script));
              });
          }
        }
      }
    }
  }
  return findings;
}

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? join(root, ".github/workflows"));
  const findings = checkDir(dir);
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.rule}: ${f.message}`);
  if (findings.length > 0) {
    console.error(`workflow-secrets: ${findings.length} finding(s)`);
    process.exit(1);
  }
  console.log("workflow-secrets: no workflow prints a secret");
}
