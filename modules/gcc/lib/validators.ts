// UAE identifier checks of the gcc module (#243; docs/21-uae-gcc-strategy.md
// row M23). Pure functions, no I/O: the module's services wrap them, and an
// app or another module imports this file for client-side checks. Formatting
// for display is the platform's template filters (`phone_ae`,
// `emirates_id`, `trn`, #233); this file validates and normalises.

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const no = (reason: string): Result<never> => ({ ok: false, reason });

/** ISO 3166-2:AE emirate codes. */
export const EMIRATES = ["AE-AZ", "AE-DU", "AE-SH", "AE-AJ", "AE-UQ", "AE-RK", "AE-FU"] as const;
export type Emirate = (typeof EMIRATES)[number];
export const isEmirate = (s: unknown): s is Emirate => typeof s === "string" && (EMIRATES as readonly string[]).includes(s);

/**
 * A UAE phone number in E.164 (`+9715XXXXXXXX` mobile, `+971[2-9]XXXXXXX`
 * landline) from what people type: spaces, dashes, brackets, `00971`, `971`,
 * or a national `0` prefix.
 */
export function phone(input: unknown): Result<string> {
  if (typeof input !== "string") return no("not_a_string");
  const digits = input.replace(/[\s\-().]/gu, "");
  if (!/^\+?\d+$/u.test(digits)) return no("characters");
  let national: string;
  if (digits.startsWith("+971")) national = digits.slice(4);
  else if (digits.startsWith("00971")) national = digits.slice(5);
  else if (digits.startsWith("971") && digits.length >= 11) national = digits.slice(3);
  else if (digits.startsWith("0")) national = digits.slice(1);
  else if (digits.startsWith("+")) return no("country");
  else national = digits;
  // Mobile: 5 then an operator digit (0, 2, 4, 5, 6, 8) and 7 digits.
  if (/^5[024568]\d{7}$/u.test(national)) return ok(`+971${national}`);
  // Landline: an area code 2-4, 6, 7, 9 and 7 digits.
  if (/^[2-4679]\d{7}$/u.test(national)) return ok(`+971${national}`);
  return no("format");
}

/** Luhn check over a string of digits. */
export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * An Emirates ID: 15 digits `784-YYYY-NNNNNNN-C` (dashes optional), the
 * country code 784, a plausible year, and the Luhn check digit C. The value
 * is the canonical dashed form.
 */
export function emiratesId(input: unknown): Result<string> {
  if (typeof input !== "string") return no("not_a_string");
  const digits = input.replace(/[\s-]/gu, "");
  if (!/^\d{15}$/u.test(digits)) return no("format");
  if (!digits.startsWith("784")) return no("country");
  const year = Number(digits.slice(3, 7));
  if (year < 1900 || year > 2100) return no("year");
  if (!luhn(digits)) return no("check_digit");
  return ok(`${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7, 14)}-${digits.slice(14)}`);
}

/** A tax registration number: 15 digits (spaces and dashes ignored). Format only: the FTA's register is not consulted. */
export function trn(input: unknown): Result<string> {
  if (typeof input !== "string") return no("not_a_string");
  const digits = input.replace(/[\s-]/gu, "");
  return /^\d{15}$/u.test(digits) ? ok(digits) : no("format");
}

/** A Makani number (Dubai's geographic address): 10 digits. */
export function makani(input: unknown): Result<string> {
  if (typeof input !== "string") return no("not_a_string");
  const digits = input.replace(/\s/gu, "");
  return /^\d{10}$/u.test(digits) ? ok(digits) : no("format");
}

/** A P.O. Box: 1 to 6 digits. */
export function poBox(input: unknown): Result<string> {
  if (typeof input !== "string") return no("not_a_string");
  const digits = input.replace(/^(p\.?\s*o\.?\s*box|po\s*box)\s*/iu, "").trim();
  return /^\d{1,6}$/u.test(digits) ? ok(digits) : no("format");
}

/**
 * Trade licence number shapes by issuing emirate (format checks only; the
 * licensing authorities' registers are not consulted). Unknown shapes of the
 * smaller emirates fall back to 4-20 letters, digits and dashes.
 */
const LICENCE: Record<Emirate, RegExp> = {
  "AE-AZ": /^CN-\d{6,8}$/u,
  "AE-DU": /^\d{6,8}$/u,
  "AE-SH": /^\d{5,8}$/u,
  "AE-AJ": /^\d{4,8}$/u,
  "AE-UQ": /^[A-Z0-9-]{4,20}$/u,
  "AE-RK": /^[A-Z0-9-]{4,20}$/u,
  "AE-FU": /^[A-Z0-9-]{4,20}$/u,
};

export function tradeLicence(input: unknown, emirate: unknown): Result<string> {
  if (typeof input !== "string") return no("not_a_string");
  if (!isEmirate(emirate)) return no("emirate");
  const value = input.trim().toUpperCase();
  return LICENCE[emirate].test(value) ? ok(value) : no("format");
}
