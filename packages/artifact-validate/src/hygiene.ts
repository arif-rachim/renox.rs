// Bundle hygiene, forbidden files (#115; docs/24-threat-model.md section B
// "Secrets in bundle" and section C "dotfiles under public/"). One rule set
// for `renox build`, which leaves these files out of public/, and for the
// control plane, which rejects an uploaded artifact holding one (rule H1).

/** public/ files over this size belong in object storage, not in the artifact. */
export const MAX_PUBLIC_FILE_BYTES = 5 * 1024 * 1024;

/** Dot-directories allowed under public/ (RFC 8615). */
const ALLOWED_DOT_DIRS = new Set([".well-known"]);

const FORBIDDEN_NAMES: [RegExp, string][] = [
  [/^\.env(\..*)?$/iu, "an environment file"],
  [/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/iu, "an SSH key"],
  [/\.(pem|key|p12|pfx|jks|keystore)$/iu, "a key or certificate file"],
  [/\.(sqlite|sqlite3|db)(-wal|-shm|-journal)?$/iu, "a database file"],
  [/\.log$/iu, "a log file"],
];

/**
 * Why `path` must not be in an artifact, or null. `path` is relative to the
 * folder being copied (`public/` in `renox build`) or to the artifact root;
 * `.well-known/` is allowed only directly under `public/`.
 */
export function forbiddenReason(path: string, options: { size?: number; underPublic?: boolean } = {}): string | null {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  for (const [re, what] of FORBIDDEN_NAMES) if (re.test(name)) return `${what} (${name})`;
  const publicRoot = options.underPublic === true ? 0 : segments[0] === "public" ? 1 : -1;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] as string;
    if (s === "node_modules") return "node_modules is bundled into code/, never copied";
    if (!s.startsWith(".")) continue;
    if (i === publicRoot && i < segments.length - 1 && ALLOWED_DOT_DIRS.has(s)) continue;
    return s === ".git" ? "a .git directory" : i === segments.length - 1 ? "a dotfile" : "a dot-directory";
  }
  const inPublic = options.underPublic === true || segments[0] === "public";
  if (inPublic && options.size !== undefined && options.size > MAX_PUBLIC_FILE_BYTES) {
    return `over ${MAX_PUBLIC_FILE_BYTES} bytes; serve large files from storage`;
  }
  return null;
}
