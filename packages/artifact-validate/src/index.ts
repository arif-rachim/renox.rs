// @renox/artifact-validate: one implementation of the artifact rules for the
// CLI (`renox check`, `renox build`) and the control plane's upload
// validation (docs/contracts/artifact.md section 6, deploy-api.md section 4),
// and the bundle-hygiene rules of #115 (forbidden files, secret scanning).

export { checkArtifactFiles, checkManifest, checkRouteTable, formatViolation, manifestRules, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_FILES, MAX_CODE_BYTES, TIERS } from "./artifact.ts";
export type { CheckOptions, CheckResult, TierLimits, Violation } from "./artifact.ts";
export { compareUtf8, contentHash, sha256Hex } from "./hash.ts";
export { pathProblem } from "./paths.ts";
export { isObject, unsupportedKeywords, validate } from "./schema.ts";
export type { Json, JsonObject } from "./schema.ts";
export { extractTar, InputTooLarge, TarRejected, UPLOAD_LIMITS, writeTar } from "./tar.ts";
export type { ExtractOptions, TarLimits } from "./tar.ts";
export { forbiddenReason, MAX_PUBLIC_FILE_BYTES } from "./hygiene.ts";
export { entropy, highEntropyValue, PATTERNS as SECRET_PATTERNS, scanText, secretName, TEXT_FILE } from "./secrets.ts";
export type { ScanResult, SecretFinding } from "./secrets.ts";
