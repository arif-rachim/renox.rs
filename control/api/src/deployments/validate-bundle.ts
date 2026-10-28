// Bundle hygiene on upload (#115; docs/24-threat-model.md section B "Secrets
// in bundle", section C "dotfiles under public/"). The same rules as
// `renox build` (@renox/artifact-validate), applied to whatever was uploaded,
// so an artifact made by hand is held to them too:
//
//   H1  a forbidden file anywhere in the tree (dotfiles except
//       public/.well-known/, keys, .env, databases, logs, node_modules,
//       public/ files over 5 MiB)
//   H2  a secret in a file stored as it is (public/, migrations/, templates/),
//       unless the line carries `renox-allow-secret: <reason>`
//
// code/ is not scanned for secrets here: bundling removes the comments that
// carry `renox-allow-secret`, and vendored SDKs give false positives, so the
// CLI scans the sources before bundling instead. A violation never quotes the
// secret, only its pattern and a masked prefix.

import { forbiddenReason, scanText, TEXT_FILE, type Violation } from "@renox/artifact-validate";

const GENERATED = new Set(["manifest.json", "public/manifest.json", "migrations/checksums.json"]);
const SCANNED = /^(public|migrations|templates)\//u;

export function bundleViolations(files: ReadonlyMap<string, Uint8Array>): Violation[] {
  const out: Violation[] = [];
  const decoder = new TextDecoder();
  for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const reason = forbiddenReason(path, { size: bytes.length });
    if (reason !== null) {
      out.push({ rule: "H1", path, reason });
      continue;
    }
    if (GENERATED.has(path) || !SCANNED.test(path) || !TEXT_FILE.test(path)) continue;
    for (const f of scanText(decoder.decode(bytes)).findings) {
      out.push({ rule: "H2", path, reason: `line ${f.line}: ${f.description} (${f.masked}); store it with the secrets API instead` });
    }
  }
  return out;
}
