// #241 / docs/15-roadmap.md (F4 done): the shop uses the auth and org
// modules and has no auth or org code of its own (#242: no org tables,
// roles, memberships or invitations either): no password handling, no auth session, no
// cookies of its own in functions/, pages/, lib/ (the cart keeps the
// platform's page `session.id`, which is not a user session).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const app = join(import.meta.dir, "..");

function sources(dir: string): string[] {
  return readdirSync(join(app, dir), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && /\.(ts|js|mjs|html)$/u.test(d.name))
    .map((d) => join(d.parentPath, d.name));
}

const FORBIDDEN = [/password/iu, /set-cookie/iu, /document\.cookie/iu, /headers\.get\(\s*["']cookie["']/iu, /__Host-/u, /\bauth__(?!public_)/u, /argon2|bcrypt|scrypt/iu, /\bjwt\b/iu, /\borg__(?!public_)/u, /\binvit/iu, /\bmembers?hip/iu, /\brole\s*[=:!]==?\s*["']/u];

test("no auth or org code in the shop: both are modules", () => {
  const hits: string[] = [];
  for (const dir of ["functions", "pages", "lib", "partials"]) {
    for (const f of sources(dir)) {
      const text = readFileSync(f, "utf8");
      for (const re of FORBIDDEN) if (re.test(text)) hits.push(`${f.slice(app.length + 1)}: ${re}`);
    }
  }
  expect(hits).toEqual([]);
  // ...and it does use it: through renox:modules only.
  const uses = ["functions", "pages"].flatMap(sources).filter((f) => readFileSync(f, "utf8").includes('from "renox:modules"'));
  expect(uses.length).toBeGreaterThan(0);
});
