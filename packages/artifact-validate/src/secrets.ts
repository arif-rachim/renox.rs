// Bundle hygiene, secret scanning (#115; docs/24-threat-model.md section B,
// "Secrets in bundle"). A curated list of high-confidence patterns plus an
// entropy check for string assignments to secret-like names. One scanner for
// `renox build` / `renox check --secrets` and for the control plane (rule H2).
//
// A finding never carries the secret itself, only its pattern and a masked
// prefix, so reports and API errors cannot leak what they found.
//
// Escape hatch: `renox-allow-secret: <reason>` on the line of the match or
// alone (in a comment) on the line above it. The reason is required.

export interface SecretFinding {
  /** 1-based line and column of the match. */
  line: number;
  column: number;
  /** Pattern id, e.g. `stripe-live-key`. */
  pattern: string;
  /** What the pattern is, for people. */
  description: string;
  /** The first characters of the match and its length, e.g. `sk_live_… (32 chars)`. */
  masked: string;
  /** The reason from a `renox-allow-secret` marker; the finding is then allowed. */
  allowed?: string;
}

interface Pattern {
  id: string;
  description: string;
  re: RegExp;
  /** How many leading characters are safe to show (the fixed prefix). */
  show: number;
  /** Extra check on the match (the whole match, then the groups). */
  accept?: (m: RegExpExecArray) => boolean;
}

const b64urlJson = (part: string): Record<string, unknown> | null => {
  try {
    const text = atob(part.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const SECRET_NAME_PARTS = new Set(["secret", "token", "key", "apikey", "password", "passwd", "pwd", "passphrase", "credential", "credentials"]);
const NOT_SECRET_NAME_PARTS = new Set(["public", "publishable", "pk", "id", "name", "path", "url", "file", "type", "length", "size", "prefix", "header", "field", "env", "count"]);

/** True when an identifier names a secret: one of its words is secret, token, key, password, ... */
export function secretName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((w) => w !== "");
  if (words.some((w) => NOT_SECRET_NAME_PARTS.has(w))) return false;
  return words.some((w) => SECRET_NAME_PARTS.has(w));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** True for a value that looks random enough to be a credential (not a hash, UUID, path, URL, or placeholder). */
export function highEntropyValue(v: string): boolean {
  if (v.length < 16 || v.length > 256) return false;
  if (/^[0-9a-f]+$/iu.test(v) || UUID.test(v) || /^[0-9]+$/u.test(v)) return false; // hashes, UUIDs, numbers
  if (/^(data:|https?:|\/|\.\/|\$\{|process\.env|env\.)/iu.test(v) || /\s/u.test(v)) return false;
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u].filter((re) => re.test(v)).length;
  return classes >= 3 && entropy(v) >= 3.5;
}

export const PATTERNS: readonly Pattern[] = [
  { id: "private-key", description: "Private key block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/gu, show: 11 },
  { id: "aws-access-key", description: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, show: 4 },
  { id: "github-token", description: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/gu, show: 4 },
  { id: "stripe-live-key", description: "Stripe live secret or restricted key", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,247}\b/gu, show: 8 },
  { id: "slack-token", description: "Slack token", re: /\bxox[abposr]-[0-9A-Za-z-]{10,250}\b/gu, show: 5 },
  { id: "slack-webhook", description: "Slack webhook URL", re: /https:\/\/hooks\.slack\.com\/services\/T[0-9A-Z]{6,}\/B[0-9A-Z]{6,}\/[0-9A-Za-z]{20,}/gu, show: 32 },
  { id: "google-api-key", description: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/gu, show: 4 },
  {
    id: "jwt-alg-none",
    description: "Unsigned JWT (alg: none)",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.?[A-Za-z0-9_-]*/gu,
    show: 3,
    accept: (m) => String(b64urlJson(m[0].split(".")[0] as string)?.alg ?? "").toLowerCase() === "none",
  },
  {
    id: "secret-assignment",
    description: "High-entropy string assigned to a secret-like name",
    // name = "value", name: string = "value", name: 'value', "name": "value", NAME=`value`
    re: /([A-Za-z_$][A-Za-z0-9_$-]*)["']?(?:\s*:\s*[A-Za-z_$][A-Za-z0-9_$<>[\]|. ]{0,40}?)?\s*(?::|=|:=)\s*(["'`])([^"'`\n]{16,256})\2/gu,
    show: 0,
    accept: (m) => secretName(m[1] as string) && highEntropyValue(m[3] as string),
  },
];

const MARKER = /renox-allow-secret(?::\s*(.*?))?\s*(?:\*\/|-->)?\s*$/u;

/** The reason of a `renox-allow-secret` marker on `line`, "" for a marker without one, or null. */
function marker(line: string): string | null {
  const at = line.indexOf("renox-allow-secret");
  if (at === -1) return null;
  const m = MARKER.exec(line.slice(at));
  return (m?.[1] ?? "").trim();
}

/** A comment line holding only the marker (so it applies to the next line). */
const markerOnly = (line: string): boolean => /^\s*(?:\/\/|#|--|\/\*|<!--|\*)\s*renox-allow-secret\b/u.test(line);

function masked(p: Pattern, m: RegExpExecArray): string {
  const value = p.id === "secret-assignment" ? (m[3] as string) : m[0];
  const shown = p.id === "secret-assignment" ? `${m[1] as string} = …` : `${value.slice(0, p.show)}…`;
  return `${shown} (${value.length} chars)`;
}

export interface ScanResult {
  /** Findings without a valid marker: these fail the build or the upload. */
  findings: SecretFinding[];
  /** Findings with a marker and its reason. */
  allowed: SecretFinding[];
  /** Markers without a reason (they allow nothing). */
  markersWithoutReason: number[];
}

/** Scans one text file. Binary-looking input (NUL bytes) is skipped. */
export function scanText(text: string): ScanResult {
  const out: ScanResult = { findings: [], allowed: [], markersWithoutReason: [] };
  if (text.includes("\0")) return out;
  const lines = text.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const seen = new Set<string>();
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (let m = p.re.exec(text); m !== null; m = p.re.exec(text)) {
      if (p.accept !== undefined && !p.accept(m)) continue;
      const li = lineOf(m.index);
      // The generic assignment rule runs last and never repeats a line a specific pattern already reported.
      if (p.id === "secret-assignment" && seen.has(String(li))) continue;
      seen.add(String(li));
      const finding: SecretFinding = { line: li + 1, column: m.index - (starts[li] as number) + 1, pattern: p.id, description: p.description, masked: masked(p, m) };
      const own = marker(lines[li] as string);
      const above = li > 0 && markerOnly(lines[li - 1] as string) ? marker(lines[li - 1] as string) : null;
      const reason = own ?? above;
      if (reason !== null && reason !== "") out.allowed.push({ ...finding, allowed: reason });
      else {
        if (reason === "") out.markersWithoutReason.push(li + 1);
        out.findings.push(finding);
      }
    }
  }
  const byPos = (a: SecretFinding, b: SecretFinding) => a.line - b.line || a.column - b.column;
  out.findings.sort(byPos);
  out.allowed.sort(byPos);
  return out;
}

/** Text files worth scanning by extension (the rest are binary assets). */
export const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|html?|css|svg|xml|txt|md|sql|ya?ml|toml|ini|cfg|conf|env|csv|map|webmanifest)$/iu;
