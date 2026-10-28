// artifact.md section 1, "Paths" (rule V1, and T4 for tar entries).

const encoder = new TextEncoder();
// eslint-disable-next-line no-control-regex
const FORBIDDEN_PATH_CHARS = /[\u0000-\u001f\u007f\\:]/u;

export const MAX_PATH_BYTES = 512;
export const MAX_PATH_SEGMENTS = 32;

/** The reason `path` breaks the path rules, or null when it is fine. */
export function pathProblem(path: string): string | null {
  if (path.normalize("NFC") !== path) return "not NFC";
  if (path.startsWith("/") || path.endsWith("/")) return "leading or trailing /";
  if (FORBIDDEN_PATH_CHARS.test(path)) return "backslash, colon, or control character";
  if (encoder.encode(path).length > MAX_PATH_BYTES) return `longer than ${MAX_PATH_BYTES} bytes`;
  const segments = path.split("/");
  if (segments.length > MAX_PATH_SEGMENTS) return `more than ${MAX_PATH_SEGMENTS} segments`;
  if (segments.some((s) => s === "" || s === "." || s === "..")) return "empty, . or .. segment";
  return null;
}
