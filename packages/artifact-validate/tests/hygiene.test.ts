// Bundle hygiene (#115): forbidden files and the secret patterns, each with
// true positives and false positives. Proves docs/24-threat-model.md section
// B, "Secrets in bundle", and section C, "dotfiles under public/".
//
// Fake credentials are assembled at run time, so this file never holds a
// string that a secret scanner (ours or GitHub's) would take for a real one.

import { describe, expect, test } from "bun:test";
import { forbiddenReason, highEntropyValue, scanText, secretName } from "../src/index.ts";

const j = (...parts: string[]): string => parts.join("");
const FAKE = {
  stripe: j("sk", "_live_", "51FAKEfakeFAKEfake0123456789abcd"),
  stripeRestricted: j("rk", "_live_", "51FAKEfakeFAKEfake0123456789abcd"),
  aws: j("AK", "IA", "FAKE0123456789AB"),
  github: j("gh", "p_", "FAKEfakeFAKEfake0123456789abcdefghij"),
  slack: j("xo", "xb-", "000000000000-FAKEfakeFAKE"),
  slackHook: j("https://hooks.slack.com/services/", "T00000000/", "B00000000/", "FAKEfakeFAKEfakeFAKEfake"),
  google: j("AI", "za", "SyFAKEfakeFAKEfake0123456789abcdefg"),
  pem: j("-----BEGIN ", "RSA PRIVATE KEY", "-----"),
  jwtNone: j("eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0", ".", "eyJzdWIiOiIxMjM0In0", "."),
  password: j("Tr0ub4dor&3", "-x9Q!zLk2"),
};

describe("forbiddenReason", () => {
  test("rejects env files, keys, databases, logs, dotfiles, .git, node_modules", () => {
    for (const p of [".env", ".env.production", "id_rsa", "id_ed25519.pub", "certs/server.pem", "tls.key", "store.p12", "app.pfx", "data.sqlite", "app.db", "app.db-wal", "debug.log", ".DS_Store", ".git/config", ".vscode/settings.json", "img/.hidden/x.png", "node_modules/x/index.js"]) {
      expect([p, forbiddenReason(p, { underPublic: true })]).not.toEqual([p, null]);
    }
  });

  test("allows .well-known only directly under public/", () => {
    expect(forbiddenReason(".well-known/security.txt", { underPublic: true })).toBeNull();
    expect(forbiddenReason("public/.well-known/assetlinks.json")).toBeNull();
    expect(forbiddenReason("img/.well-known/x", { underPublic: true })).not.toBeNull();
    expect(forbiddenReason("code/.well-known/x.js")).not.toBeNull();
    expect(forbiddenReason("public/.well-known")).not.toBeNull(); // a file named .well-known
  });

  test("allows ordinary assets and the artifact's own files", () => {
    for (const p of ["style.css", "img/logo.png", "keyboard.svg", "monkey.js", "db-schema.png", "login.html", "turkey.jpg"]) expect(forbiddenReason(p, { underPublic: true })).toBeNull();
    for (const p of ["manifest.json", "code/functions/api/hello.js", "code/chunks/chunk-abc.js", "migrations/app/001_init.sql", "public/manifest.json"]) expect(forbiddenReason(p)).toBeNull();
  });

  test("public/ files over 5 MiB", () => {
    expect(forbiddenReason("video.mp4", { underPublic: true, size: 5 * 1024 * 1024 + 1 })).toContain("storage");
    expect(forbiddenReason("public/video.mp4", { size: 5 * 1024 * 1024 + 1 })).toContain("storage");
    expect(forbiddenReason("video.mp4", { underPublic: true, size: 5 * 1024 * 1024 })).toBeNull();
    expect(forbiddenReason("code/big.js", { size: 6 * 1024 * 1024 })).toBeNull();
  });
});

describe("scanText: true positives", () => {
  const cases: [string, string][] = [
    ["stripe-live-key", `const stripe = new Stripe("${FAKE.stripe}");`],
    ["stripe-live-key", `STRIPE=${FAKE.stripeRestricted}`],
    ["aws-access-key", `accessKeyId: "${FAKE.aws}",`],
    ["github-token", `const gh = '${FAKE.github}';`],
    ["slack-token", `token: "${FAKE.slack}"`],
    ["slack-webhook", `await fetch("${FAKE.slackHook}")`],
    ["google-api-key", `<script src="https://maps.googleapis.com/maps/api/js?key=${FAKE.google}"></script>`],
    ["private-key", `"private_key": "${FAKE.pem}\\nMIIEow..."`],
    ["jwt-alg-none", `const t = "${FAKE.jwtNone}";`],
    ["secret-assignment", `const password = "${FAKE.password}";`],
    ["secret-assignment", `const apiKey: string = "${FAKE.password}";`],
    ["secret-assignment", `{ "client_secret": "${FAKE.password}" }`],
    ["secret-assignment", `export const SESSION_TOKEN = \`${FAKE.password}\`;`],
  ];
  for (const [pattern, line] of cases) {
    test(`${pattern}: ${line.slice(0, 40)}`, () => {
      const r = scanText(`// header\n${line}\n`);
      expect(r.findings.map((f) => [f.pattern, f.line])).toContainEqual([pattern, 2]);
    });
  }

  test("a finding never carries the secret", () => {
    const r = scanText(`const k = "${FAKE.stripe}";\nconst password = "${FAKE.password}";`);
    expect(r.findings).toHaveLength(2);
    for (const f of r.findings) {
      expect(JSON.stringify(f)).not.toContain(FAKE.stripe.slice(8));
      expect(JSON.stringify(f)).not.toContain(FAKE.password);
    }
    expect(r.findings[0]?.masked).toBe(`sk_live_… (${FAKE.stripe.length} chars)`);
    expect(r.findings[0]).toMatchObject({ line: 1, column: 12 });
  });
});

describe("scanText: false positives", () => {
  const corpus = [
    // hashes
    `const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";`,
    `const integrityKey = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";`,
    `{"sha256": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"}`,
    // UUIDs
    `const requestToken = "123e4567-e89b-12d3-a456-426614174000";`,
    `{"id": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "key": "6ba7b810-9dad-11d1-80b4-00c04fd430c8"}`,
    // base64 images
    `const logo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";`,
    `.icon { background: url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMCAxMCI+PC9zdmc+"); }`,
    // test keys, placeholders, env lookups, public keys
    `const stripe = new Stripe(env.STRIPE_KEY ?? "${j("sk", "_test_")}FAKEfakeFAKEfake0123456789");`,
    `const publishableKey = "${j("pk", "_live_")}FAKEfakeFAKEfake0123456789abcd";`,
    `const password = "your-password-here-please";`,
    `const apiKey = process.env.API_KEY;`,
    `const tokenUrl = "https://oauth2.googleapis.com/token?client=abcDEF123";`,
    `const secretPath = "/var/run/secrets/kubernetes.io/serviceaccount";`,
    `const keyName = "Content-Security-Policy-Report";`,
    // a signed JWT is not alg none
    `const t = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";`,
    // the word key in other names
    `const monkey = "Xy7#kLm9!pQr2$sTu4";`,
    `const keyboardLayout = "Xy7#kLm9!pQr2$sTu4";`,
  ];
  test("the corpus passes", () => {
    for (const text of corpus) expect([text, scanText(text).findings]).toEqual([text, []]);
  });

  test("binary content is skipped", () => {
    expect(scanText(`\0\0${FAKE.stripe}`).findings).toEqual([]);
  });
});

describe("renox-allow-secret", () => {
  test("on the same line, with a reason, allows it and keeps the reason", () => {
    const r = scanText(`const k = "${FAKE.stripe}"; // renox-allow-secret: revoked key used as a test fixture`);
    expect(r.findings).toEqual([]);
    expect(r.allowed.map((f) => [f.pattern, f.allowed])).toEqual([["stripe-live-key", "revoked key used as a test fixture"]]);
  });

  test("alone on the line above, in any comment style", () => {
    for (const c of ["// renox-allow-secret: public Maps browser key", "# renox-allow-secret: public Maps browser key", "<!-- renox-allow-secret: public Maps browser key -->", "/* renox-allow-secret: public Maps browser key */"]) {
      const r = scanText(`${c}\nkey=${FAKE.google}\n`);
      expect([c, r.findings, r.allowed.map((f) => f.allowed)]).toEqual([c, [], ["public Maps browser key"]]);
    }
  });

  test("without a reason it allows nothing", () => {
    for (const c of [`const k = "${FAKE.stripe}"; // renox-allow-secret`, `const k = "${FAKE.stripe}"; // renox-allow-secret:   `]) {
      const r = scanText(c);
      expect(r.findings).toHaveLength(1);
      expect(r.markersWithoutReason).toEqual([1]);
    }
  });

  test("applies to its own line and the next one only", () => {
    const r = scanText(`// renox-allow-secret: fixture\nconst a = 1;\nconst k = "${FAKE.stripe}";`);
    expect(r.findings.map((f) => f.line)).toEqual([3]);
  });
});

describe("helpers", () => {
  test("secretName", () => {
    for (const n of ["password", "apiKey", "API_KEY", "client_secret", "SESSION_TOKEN", "dbPassword", "x-api-key"]) expect([n, secretName(n)]).toEqual([n, true]);
    for (const n of ["monkey", "keyboard", "publishableKey", "keyName", "tokenUrl", "secretPath", "primaryKeyId", "tokens_count"]) expect([n, secretName(n)]).toEqual([n, false]);
  });

  test("highEntropyValue", () => {
    expect(highEntropyValue(FAKE.password)).toBe(true);
    expect(highEntropyValue("changeme-changeme")).toBe(false);
    expect(highEntropyValue("e3b0c44298fc1c149afbf4c8996fb924")).toBe(false);
  });
});
