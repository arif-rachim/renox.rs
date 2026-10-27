// The error code lists match the table of docs/contracts/ops.md section 13,
// and the error classes behave as the contract describes.

import { describe, expect, test } from "bun:test";
import {
  DbConstraintError,
  DbUsageError,
  DeadlineError,
  FetchBlockedError,
  isRenoxError,
  RENOX_ERROR_CODES,
  RenoxError,
  RESPONSE_ERROR_CODES,
} from "../src/index.ts";

const opsPath = new URL("../../docs/contracts/ops.md", import.meta.url);

/** `| \`CODE\` | thrown|response|both | ...` rows of section 13. */
async function opsTable(): Promise<Map<string, string>> {
  const text = await Bun.file(opsPath).text();
  const start = text.indexOf("## 13. Error codes");
  const end = text.indexOf("\n## ", start + 1);
  expect(start).toBeGreaterThan(-1);
  const section = text.slice(start, end === -1 ? undefined : end);
  const rows = new Map<string, string>();
  for (const m of section.matchAll(/^\| `(RENOX_[A-Z_]+)` \| (thrown|response|both) \|/gm)) {
    rows.set(m[1]!, m[2]!);
  }
  return rows;
}

describe("error code table (ops.md section 13)", () => {
  test("every RENOX_* code in the table is in the SDK lists, with the right kind", async () => {
    const table = await opsTable();
    expect(table.size).toBeGreaterThanOrEqual(20);
    const thrown = new Set<string>(RENOX_ERROR_CODES);
    const response = new Set<string>(RESPONSE_ERROR_CODES);
    for (const [code, kind] of table) {
      expect({ code, inThrown: thrown.has(code) }).toEqual({ code, inThrown: kind !== "response" });
      expect({ code, inResponse: response.has(code) }).toEqual({ code, inResponse: kind !== "thrown" });
    }
  });

  test("the SDK lists contain no code missing from the table", async () => {
    const table = await opsTable();
    for (const code of [...RENOX_ERROR_CODES, ...RESPONSE_ERROR_CODES]) {
      expect(table.has(code)).toBe(true);
    }
    expect(new Set(RENOX_ERROR_CODES).size).toBe(RENOX_ERROR_CODES.length);
    expect(new Set(RESPONSE_ERROR_CODES).size).toBe(RESPONSE_ERROR_CODES.length);
  });
});

describe("error classes", () => {
  test("RenoxError carries code and frozen details", () => {
    const e = new RenoxError("RENOX_NO_REQUEST", "no request in scope", { op: "op_db_query" });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("RenoxError");
    expect(e.code).toBe("RENOX_NO_REQUEST");
    expect(e.details).toEqual({ op: "op_db_query" });
    expect(Object.isFrozen(e.details)).toBe(true);
    expect(new RenoxError("RENOX_DB_SQL", "x").details).toBeUndefined();
  });

  test("subclasses set their own code and name", () => {
    const blocked = new FetchBlockedError("blocked", { host: "169.254.169.254", reason: "blocked_address" });
    expect(blocked).toBeInstanceOf(RenoxError);
    expect(blocked.name).toBe("FetchBlockedError");
    expect(blocked.code).toBe("RENOX_FETCH_BLOCKED");
    expect(blocked.details.reason).toBe("blocked_address");
    expect(new DeadlineError("late").code).toBe("RENOX_DEADLINE");
    expect(new DbUsageError("RENOX_DB_PARAM", "bad param").code).toBe("RENOX_DB_PARAM");
    expect(new DbConstraintError("dup", { kind: "unique" }).details.kind).toBe("unique");
  });

  test("isRenoxError checks the code, not the class identity", () => {
    const foreign = Object.assign(new Error("from runtime glue"), { code: "RENOX_DB_BUSY" });
    expect(isRenoxError(foreign)).toBe(true);
    expect(isRenoxError(new DeadlineError("late"))).toBe(true);
    expect(isRenoxError(Object.assign(new Error("x"), { code: "RENOX_CPU_LIMIT" }))).toBe(false);
    expect(isRenoxError(new Error("plain"))).toBe(false);
    expect(isRenoxError({ code: "RENOX_DB_BUSY" })).toBe(false);
  });
});
