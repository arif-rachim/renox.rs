// The documentation embedded at compile time (embed.ts is a Bun macro), and a
// small full-text search over it for the `search_docs` tool.

import { embedCtxTypes, embedDocs } from "./embed.ts" with { type: "macro" };

export const DOCS: Readonly<Record<string, string>> = Object.freeze(embedDocs());
export const CTX_TYPES: string = embedCtxTypes();

/** The first `# ` heading of a document, or its path. */
export const titleOf = (path: string): string => /^# (.+)$/mu.exec(DOCS[path] ?? "")?.[1]?.trim() ?? path;

export interface DocHit {
  uri: string;
  title: string;
  /** The section heading the match is under. */
  section: string;
  line: number;
  snippet: string;
  score: number;
}

const words = (q: string): string[] =>
  q
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.-]+/u)
    .filter((w) => w.length >= 2);

const SNIPPET = 240;

/**
 * The line, or a window of it when it is long: around the query phrase when
 * the line contains it, else around the first matched term.
 */
function snippet(line: string, terms: string[], phrase: string): string {
  if (line.length <= SNIPPET) return line;
  const lower = line.toLowerCase();
  const p = terms.length > 1 ? lower.indexOf(phrase) : -1;
  const at = p >= 0 ? p : Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0));
  const start = Math.max(0, Math.min(at - 60, line.length - SNIPPET));
  return `${start > 0 ? "…" : ""}${line.slice(start, start + SNIPPET)}${start + SNIPPET < line.length ? "…" : ""}`;
}

/**
 * Lines that contain every query word (case-insensitive), the lines with the
 * words as one phrase first, then ranked by how many times the words occur
 * in the line's section; at most `limit` hits.
 */
export function searchDocs(query: string, limit = 10): DocHit[] {
  const terms = words(query);
  if (terms.length === 0) return [];
  // A line with the query words in order, as one phrase, ranks first (#734:
  // a long section that only mentions the words apart, such as a changelog
  // table, no longer outranks the line that states the phrase).
  const phrase = terms.join(" ");
  const hits: (DocHit & { phrase: boolean })[] = [];
  for (const [path, text] of Object.entries(DOCS)) {
    const lines = text.split("\n");
    let section = titleOf(path);
    let sectionStart = 0;
    const sectionText = (from: number): string => {
      let end = from + 1;
      while (end < lines.length && !/^#{1,6} /u.test(lines[end] as string)) end++;
      return lines.slice(from, end).join("\n").toLowerCase();
    };
    let sectionLower = sectionText(0);
    lines.forEach((raw, i) => {
      if (/^#{1,6} /u.test(raw)) {
        section = raw.replace(/^#+ /u, "").trim();
        sectionStart = i;
        sectionLower = sectionText(sectionStart);
      }
      const lower = raw.toLowerCase();
      if (!terms.every((t) => lower.includes(t))) return;
      const score = terms.reduce((n, t) => n + sectionLower.split(t).length - 1, 0) + (i === sectionStart ? 5 : 0);
      const hasPhrase = terms.length > 1 && lower.includes(phrase);
      hits.push({ uri: `docs://${path}`, title: titleOf(path), section, line: i + 1, snippet: snippet(raw.trim(), terms, phrase), score, phrase: hasPhrase });
    });
  }
  return hits
    .sort((a, b) => Number(b.phrase) - Number(a.phrase) || b.score - a.score || a.uri.localeCompare(b.uri) || a.line - b.line)
    .slice(0, limit)
    .map(({ phrase: _, ...hit }) => hit);
}
