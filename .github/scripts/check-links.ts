// Markdown link check for the CI `docs` job: every relative link in a tracked
// markdown file must point at an existing file or directory. External URLs are
// not fetched (the job must not depend on the network).
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const patterns = ["*.md", "docs/**/*.md", "bench/**/*.md", "examples/**/*.md"];
const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const files = new Set<string>();
for (const pattern of patterns) {
  for (const file of new Bun.Glob(pattern).scanSync({ cwd: root })) {
    if (!file.includes("node_modules/")) files.add(file);
  }
}

let broken = 0;
for (const file of [...files].sort()) {
  const text = await Bun.file(join(root, file)).text();
  // Ignore fenced code blocks: they hold examples, not links.
  const prose = text.replace(/```[\s\S]*?```/g, "");
  for (const match of prose.matchAll(linkRe)) {
    const target = match[1] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
    const path = decodeURIComponent(target.split("#")[0] ?? "");
    if (path === "") continue;
    const abs = path.startsWith("/") ? join(root, path) : join(root, dirname(file), path);
    if (!existsSync(abs)) {
      console.error(`${file}: broken link -> ${target}`);
      broken++;
    }
  }
}

console.log(`checked ${files.size} markdown files, ${broken} broken links`);
process.exit(broken === 0 ? 0 : 1);
