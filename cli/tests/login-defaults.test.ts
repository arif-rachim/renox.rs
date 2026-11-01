// The API the CLI talks to by default (#364; docs/contracts/README.md
// "Domains"): the platform's own services live on renoxium.com, never under
// the tenant domain renox.rs. RENOX_API_URL overrides it.

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_API, apiAuth } from "../src/commands/login.ts";

const TOKEN = `renox_pat_${"a".repeat(32)}`;
const cfg = () => mkdtempSync(join(tmpdir(), "renox-cfg-"));

test("the default API is https://api.renoxium.com; RENOX_API_URL overrides it", () => {
  expect(DEFAULT_API).toBe("https://api.renoxium.com");
  expect(apiAuth({ RENOX_TOKEN: TOKEN, XDG_CONFIG_HOME: cfg() }).api).toBe("https://api.renoxium.com");
  expect(apiAuth({ RENOX_TOKEN: TOKEN, RENOX_API_URL: "https://api.example.test/", XDG_CONFIG_HOME: cfg() }).api).toBe("https://api.example.test");
});
