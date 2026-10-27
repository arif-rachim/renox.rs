// `bun run examples/npm-compat/checks/_all.ts`: runs every check outside the
// isolate, one line per package, exit 1 if any fails. Separates "package
// broken" from "package broken in the isolate" (B17, issue #8).
import { runAll } from "./_run.ts";

const results = await runAll();
for (const r of results) {
  const status = r.ok ? "ok  " : "FAIL";
  console.log(`${status} ${r.package}@${r.version} ${r.ms.toFixed(1)} ms${r.error ? ` ${r.error}` : ""}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
