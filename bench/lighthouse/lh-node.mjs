// Runs one Lighthouse audit through its Node API, in Node (Lighthouse targets
// Node; run.ts is Bun). Usage: node lh-node.mjs '<json args>', where the args are
// { url, port, headers, out, categories }. Writes the report JSON to `out`.
import { writeFileSync } from "node:fs";
import lighthouse from "lighthouse";

const { url, port, headers, out, categories } = JSON.parse(process.argv[2]);
const result = await lighthouse(url, {
  port,
  output: "json",
  logLevel: "error",
  onlyCategories: categories,
  extraHeaders: headers,
});
if (!result) throw new Error("lighthouse returned no result");
writeFileSync(out, typeof result.report === "string" ? result.report : JSON.stringify(result.report));
