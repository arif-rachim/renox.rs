// #284: WebAuthn verification on Web Crypto. A recorded registration and
// assertion for each supported shape (ES256 with "none" attestation, ES256
// with packed self attestation, RS256; tests/fixtures/webauthn/record.ts
// wrote them) verify; a wrong origin, a wrong RP id, a wrong challenge, a
// tampered signature and a replayed counter are refused.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fromBase64url, verifyAssertion, verifyRegistration, WebAuthnError } from "../src/index.ts";

interface Recorded {
  registration: { challenge: string; response: { clientDataJSON: string; attestationObject: string } };
  assertion: { challenge: string; response: { clientDataJSON: string; authenticatorData: string; signature: string } };
  credentialId: string;
}
const FIX = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/webauthn/webauthn.json"), "utf8")) as {
  rpId: string;
  origin: string;
  es256: Recorded;
  es256Packed: Recorded;
  rs256: Recorded;
};

const expected = (challenge: string) => ({ expectedChallenge: challenge, expectedOrigin: FIX.origin, expectedRpId: FIX.rpId });

async function refused(p: Promise<unknown>, reason: WebAuthnError["reason"]): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(WebAuthnError);
  expect((e as WebAuthnError).reason).toBe(reason);
}

for (const [name, alg, fmt] of [
  ["es256", -7, "none"],
  ["es256Packed", -7, "packed"],
  ["rs256", -257, "none"],
] as const) {
  describe(name, () => {
    const r = FIX[name];

    test("the recorded registration and assertion verify", async () => {
      const cred = await verifyRegistration({ ...expected(r.registration.challenge), response: r.registration.response, requireUserVerification: true });
      expect(cred).toMatchObject({ credentialId: r.credentialId, algorithm: alg, counter: 0, userVerified: true, attestationFormat: fmt });
      const out = await verifyAssertion({ ...expected(r.assertion.challenge), response: r.assertion.response, credential: { publicKey: cred.publicKey, counter: cred.counter } });
      expect(out).toEqual({ counter: 1, userVerified: true });
    });

    test("a wrong origin, RP id or challenge is refused", async () => {
      const ok = expected(r.registration.challenge);
      await refused(verifyRegistration({ ...ok, expectedOrigin: "https://evil.example", response: r.registration.response }), "origin");
      await refused(verifyRegistration({ ...ok, expectedRpId: "evil.example", response: r.registration.response }), "rp_id");
      await refused(verifyRegistration({ ...ok, expectedChallenge: r.assertion.challenge, response: r.registration.response }), "challenge");
      // An assertion offered as a registration has the wrong type.
      await refused(verifyRegistration({ ...expected(r.assertion.challenge), response: { clientDataJSON: r.assertion.response.clientDataJSON, attestationObject: r.registration.response.attestationObject } }), "type");
    });

    test("a replayed counter and a tampered signature are refused", async () => {
      const cred = await verifyRegistration({ ...expected(r.registration.challenge), response: r.registration.response });
      const get = { ...expected(r.assertion.challenge), response: r.assertion.response };
      // The stored counter is already 1: the same assertion again is a replay.
      await refused(verifyAssertion({ ...get, credential: { publicKey: cred.publicKey, counter: 1 } }), "counter");
      const sig = fromBase64url(r.assertion.response.signature);
      sig[sig.length - 1] = (sig[sig.length - 1] as number) ^ 1;
      const tampered = { ...r.assertion.response, signature: Buffer.from(sig).toString("base64url") };
      await refused(
        verifyAssertion({ ...get, response: tampered, credential: { publicKey: cred.publicKey, counter: 0 } }).catch((e: unknown) => {
          // A flipped DER byte may break the encoding itself: either way a signature refusal.
          throw e instanceof WebAuthnError ? e : new WebAuthnError("signature", String(e));
        }),
        "signature",
      );
      await refused(verifyAssertion({ ...get, expectedOrigin: "https://shop.example:8443", credential: { publicKey: cred.publicKey, counter: 0 } }), "origin");
      await refused(verifyAssertion({ ...get, expectedRpId: "example", credential: { publicKey: cred.publicKey, counter: 0 } }), "rp_id");
    });
  });
}
