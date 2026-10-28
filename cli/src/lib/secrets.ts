// Secret scan of what `renox build` ships (#115; docs/24-threat-model.md
// section B, "Secrets in bundle"). The patterns are the shared ones of
// @renox/artifact-validate, the same the control plane applies.
//
// Scanned: the project's own sources that went into code/ (from the source
// maps, so exactly what was bundled, by original file and line), and every
// text file copied as it is (public/, migrations/). Not scanned: vendored
// npm code (the Stripe SDK alone gives false positives) and the bundle
// output, where comments, and so `renox-allow-secret` markers, are gone.

import { scanText, TEXT_FILE, type SecretFinding } from "@renox/artifact-validate";

export interface ProjectSecret extends SecretFinding {
  /** Project-relative path of the file that holds it. */
  file: string;
}

export interface SecretReport {
  findings: ProjectSecret[];
  allowed: ProjectSecret[];
  /** `renox-allow-secret` markers without a reason: they allow nothing. */
  markersWithoutReason: { file: string; line: number }[];
  /** How many files were scanned. */
  files: number;
}

export const SECRET_HINT = "keep it out of the code: renox secrets set <NAME>, then read ctx.secrets.<NAME>";

const vendored = (source: string): boolean => source.startsWith("../") || source.startsWith("/") || source.split("/").includes("node_modules");

/** Scans the bundled sources (via `maps`, code/-relative path → source map JSON) and the copied text files of `files`. */
export function scanBundle(maps: ReadonlyMap<string, string>, files: ReadonlyMap<string, Uint8Array>): SecretReport {
  const texts = new Map<string, string>();
  for (const map of maps.values()) {
    const m = JSON.parse(map) as { sources?: string[]; sourcesContent?: (string | null)[] };
    (m.sources ?? []).forEach((source, i) => {
      const content = m.sourcesContent?.[i];
      if (!vendored(source) && typeof content === "string" && !texts.has(source)) texts.set(source, content);
    });
  }
  const decoder = new TextDecoder();
  for (const [path, bytes] of files) {
    if (path.startsWith("code/") || path === "manifest.json" || path === "public/manifest.json" || path === "migrations/checksums.json") continue;
    if (!TEXT_FILE.test(path)) continue;
    // migrations/app/NNN.sql is migrations/NNN.sql in the project.
    texts.set(path.replace(/^migrations\/app\//u, "migrations/"), decoder.decode(bytes));
  }
  const report: SecretReport = { findings: [], allowed: [], markersWithoutReason: [], files: texts.size };
  for (const [file, text] of [...texts].sort(([a], [b]) => a.localeCompare(b))) {
    const r = scanText(text);
    report.findings.push(...r.findings.map((f) => ({ ...f, file })));
    report.allowed.push(...r.allowed.map((f) => ({ ...f, file })));
    report.markersWithoutReason.push(...r.markersWithoutReason.map((line) => ({ file, line })));
  }
  return report;
}

/** One line per finding: `file:line:col  description  masked`. */
export const formatSecret = (f: ProjectSecret): string => `${f.file}:${f.line}:${f.column}  ${f.pattern}  ${f.description}: ${f.masked}`;
