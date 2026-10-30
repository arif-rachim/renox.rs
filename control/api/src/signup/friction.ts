// Sign-up friction (#123; deploy-api.md 0.5 section 21, "Friction"): a
// disposable address domain is refused before anything is stored. The
// per-IP and per-ASN rates use the API's limiter (src/auth/accounts.ts).

/** A short list of well-known disposable domains; operators extend it with RENOX_DISPOSABLE_DOMAINS. */
const BUILTIN = ["mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "yopmail.com", "trashmail.com", "sharklasers.com", "getnada.com", "dispostable.com", "maildrop.cc", "throwawaymail.com"];

export function disposable(email: string, extra = process.env.RENOX_DISPOSABLE_DOMAINS ?? ""): boolean {
  const domain = email.split("@").pop()?.toLowerCase() ?? "";
  const list = new Set([...BUILTIN, ...extra.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)]);
  return [...list].some((d) => domain === d || domain.endsWith(`.${d}`));
}
