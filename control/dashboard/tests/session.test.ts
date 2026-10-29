// lib/session.ts: a stored sign-in is encrypted, bound to its session, and
// expires like an API session (24 h idle, 30 days absolute).
import { expect, test } from "bun:test";

import { ABSOLUTE_MS, currentToken, IDLE_MS, SessionKeyMissing, signIn, signOut } from "../lib/session.ts";
import { dashDb, SECRETS, statements } from "./helpers.ts";

const TOKEN = `renox_pat_${"a".repeat(32)}`;
const A = "AAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBB";
const T0 = 1_793_318_400_000;

/**
 * docs/24-threat-model.md B, "Secrets in logs, errors, bundle, responses":
 * the token is never in the database in the clear.
 */
test("a sign-in round-trips and the token is stored only encrypted", async () => {
  const sqlite = dashDb();
  const db = statements(sqlite);
  await signIn(db, SECRETS, A, TOKEN, T0);
  expect(await currentToken(db, SECRETS, A, T0 + 1000)).toBe(TOKEN);
  const dump = JSON.stringify(sqlite.query("select * from app__sessions").all());
  expect(dump).not.toContain(TOKEN);
  expect(dump).not.toContain("renox_pat_");
  expect(await currentToken(db, SECRETS, B, T0)).toBeNull();
});

test("a row copied to another session, or read with another key, does not decrypt and is deleted", async () => {
  const sqlite = dashDb();
  const db = statements(sqlite);
  await signIn(db, SECRETS, A, TOKEN, T0);
  sqlite.exec(`insert into app__sessions select '${B}', token_iv, token_ct, created_at, seen_at from app__sessions where session_id = '${A}'`);
  expect(await currentToken(db, SECRETS, B, T0)).toBeNull();
  expect(sqlite.query("select count(*) as n from app__sessions where session_id = ?").get(B)).toEqual({ n: 0 });
  expect(await currentToken(db, { DASHBOARD_KEY: "another-key-0123456789abcdefghijkl" }, A, T0)).toBeNull();
  expect(sqlite.query("select count(*) as n from app__sessions").get()).toEqual({ n: 0 });
});

test("idle and absolute expiry; sign-out deletes the row", async () => {
  const db = statements(dashDb());
  await signIn(db, SECRETS, A, TOKEN, T0);
  expect(await currentToken(db, SECRETS, A, T0 + IDLE_MS + 1)).toBeNull();

  await signIn(db, SECRETS, A, TOKEN, T0);
  // Seen every 20 hours: never idle, but past 30 days it ends.
  let now = T0;
  while (now + 20 * 3600 * 1000 < T0 + ABSOLUTE_MS) {
    now += 20 * 3600 * 1000;
    expect(await currentToken(db, SECRETS, A, now)).toBe(TOKEN);
  }
  expect(await currentToken(db, SECRETS, A, T0 + ABSOLUTE_MS + 1)).toBeNull();

  await signIn(db, SECRETS, A, TOKEN, T0);
  await signOut(db, A);
  expect(await currentToken(db, SECRETS, A, T0)).toBeNull();
});

test("without DASHBOARD_KEY (or a short one) nothing is stored or read", async () => {
  const db = statements(dashDb());
  await expect(signIn(db, {}, A, TOKEN, T0)).rejects.toBeInstanceOf(SessionKeyMissing);
  await expect(signIn(db, { DASHBOARD_KEY: "short" }, A, TOKEN, T0)).rejects.toBeInstanceOf(SessionKeyMissing);
  await signIn(db, SECRETS, A, TOKEN, T0);
  await expect(currentToken(db, {}, A, T0)).rejects.toBeInstanceOf(SessionKeyMissing);
});

test("only a tenant token is accepted", async () => {
  const db = statements(dashDb());
  for (const bad of ["renox_node_" + "a".repeat(32), "renox_pat_short", `renox_pat_${"A".repeat(32)}`, ""]) {
    await expect(signIn(db, SECRETS, A, bad, T0)).rejects.toThrow("not a tenant token");
  }
});
