// Official packages (@oslojs/crypto, @oslojs/encoding), the successor of the
// deprecated `oslo` package and what arctic itself depends on.
import { sha256 } from "@oslojs/crypto/sha2";
import { encodeBase64urlNoPadding, encodeHexLowerCase } from "@oslojs/encoding";
import { assertEqual } from "./_lib/assert.ts";

export async function check(): Promise<void> {
  const digest = sha256(new TextEncoder().encode("abc"));
  assertEqual(
    encodeHexLowerCase(digest),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "sha256('abc')",
  );
  assertEqual(encodeBase64urlNoPadding(digest), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0", "base64url");
}
