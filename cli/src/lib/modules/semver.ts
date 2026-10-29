// Versions and ranges of docs/contracts/manifest.md section 2: semver
// MAJOR.MINOR.PATCH[-pre] and the fixed subset of npm ranges (^, ~, exact,
// ">=A <B"). The TypeScript twin of the checks in docs/contracts/validate.ts.

export type Semver = [number, number, number, string[]];

export function parseVersion(v: string): Semver | null {
  const m = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$/u.exec(v);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? [] : m[4].split(".")];
}

/** Semver precedence: a release is above its pre-releases; numeric identifiers compare as numbers. */
export function compareVersions(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  const [pa, pb] = [a[3], b[3]];
  if (pa.length === 0 || pb.length === 0) return pb.length - pa.length;
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const [x, y] = [pa[i] as string, pb[i] as string];
    if (x === y) continue;
    const [nx, ny] = [/^[0-9]+$/u.test(x), /^[0-9]+$/u.test(y)];
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

const LOOSE = /^([~^])(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?(?:\.(0|[1-9][0-9]*))?$/u;
const INTERVAL = /^>=(\S+) <(\S+)$/u;

/** Whether `range` is one of the accepted forms. */
export function isRange(range: string): boolean {
  if (LOOSE.test(range)) return true;
  const i = INTERVAL.exec(range);
  if (i !== null) return parseVersion(i[1] as string) !== null && parseVersion(i[2] as string) !== null;
  return parseVersion(range.replace(/^=/u, "")) !== null;
}

/** Does `version` satisfy `range`? A pre-release satisfies only an exact range naming it. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (v === null) return false;
  const interval = INTERVAL.exec(range);
  if (interval !== null) {
    const [lo, hi] = [parseVersion(interval[1] as string), parseVersion(interval[2] as string)];
    return lo !== null && hi !== null && v[3].length === 0 && compareVersions(v, lo) >= 0 && compareVersions(v, hi) < 0;
  }
  const loose = LOOSE.exec(range);
  if (loose !== null) {
    if (v[3].length > 0) return false;
    const parts = [loose[2], loose[3], loose[4]].filter((p) => p !== undefined).map(Number);
    const lo: Semver = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, []];
    const hi: Semver = [0, 0, 0, []];
    // ~: the next minor (the next major for ~X); ^: the next change of the left-most non-zero part given.
    const nonZero = parts.findIndex((p) => p !== 0);
    const at = loose[1] === "~" ? Math.min(parts.length - 1, 1) : nonZero === -1 ? parts.length - 1 : nonZero;
    for (let i = 0; i < at; i++) hi[i] = lo[i] as number;
    hi[at] = (lo[at] as number) + 1;
    return compareVersions(v, lo) >= 0 && compareVersions(v, hi) < 0;
  }
  const exact = parseVersion(range.replace(/^=/u, ""));
  return exact !== null && compareVersions(v, exact) === 0;
}
