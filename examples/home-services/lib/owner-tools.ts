// What the owner connector's App MCP tools share (functions/tools: get_settings,
// update_settings, upload_logo, list_branches, add_branch, update_branch,
// list_services, add_service, update_service, list_people; docs/20-ai-agents-mcp.md
// section 1b): the input schemas as the contract writes them and their checks,
// the settings the tools show, and the logo's byte check. Nothing here imports
// `renox:modules` (a tool file is evaluated by `renox build`); the tools import
// lib/admin.ts and lib/setup.ts inside `run`.
import type { DbStatements } from "@renoxium/sdk";

import { getSettings, logoSrc } from "./settings";

export type Issue = { message: string; path: string[] };
type Raw = Record<string, unknown>;

/** The emirates a branch may name (the setup's list, deploy-api.md section 21). */
export const EMIRATES = ["abu_dhabi", "dubai", "sharjah", "ajman", "umm_al_quwain", "ras_al_khaimah", "fujairah"] as const;
export const MAX_LOGO_BYTES = 512 * 1024;
/** The base64 of exactly `MAX_LOGO_BYTES` bytes is this long: the longest `image` string that can still decode within the cap. */
export const MAX_LOGO_BASE64 = Math.ceil(MAX_LOGO_BYTES / 3) * 4;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/svg+xml"] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/u;
const COLOR = /^#[0-9a-fA-F]{6}$/u;
const BRANCH_ID = /^[a-z0-9_]{1,64}$/u;

// ------------------------------------------------------------- field checks

const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

/** The object at `key`, or an issue; `additionalProperties: false`: a key outside `allowed` is an issue. */
function objectAt(raw: Raw, key: string, allowed: readonly string[], issues: Issue[], path: string[] = []): Raw | undefined {
  const v = raw[key];
  if (!isObject(v)) {
    issues.push({ message: `${key} is an object`, path: [...path, key] });
    return undefined;
  }
  for (const k of Object.keys(v)) if (!allowed.includes(k)) issues.push({ message: `${k} is not a property of ${key}`, path: [...path, key, k] });
  return v;
}

/** Keys of the top level outside `allowed` (additionalProperties: false). */
function noExtra(raw: Raw, allowed: readonly string[], issues: Issue[]): void {
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) issues.push({ message: `${k} is not a property`, path: [k] });
}

/** A trimmed string of `min` to `max` characters at `o[key]`, or undefined (an issue when it is wrong; none when absent and optional). */
function text(o: Raw, key: string, min: number, max: number, issues: Issue[], path: string[], optional: boolean): string | undefined {
  const v = o[key];
  if (v === undefined && optional) return undefined;
  const t = typeof v === "string" ? v.trim() : "";
  if (typeof v !== "string" || t.length < min || t.length > max) {
    issues.push({ message: `${key} is ${min === 0 ? "at most" : `${min} to`} ${max} characters`, path: [...path, key] });
    return undefined;
  }
  return t;
}

function emirateAt(o: Raw, issues: Issue[], path: string[], optional: boolean): string | undefined {
  const v = o.emirate;
  if (v === undefined && optional) return undefined;
  if (typeof v !== "string" || !(EMIRATES as readonly string[]).includes(v.trim())) {
    issues.push({ message: `emirate is one of ${EMIRATES.join(", ")}`, path: [...path, "emirate"] });
    return undefined;
  }
  return v.trim();
}

/** `price_aed` in fils, or undefined (an issue when it is wrong; none when absent and optional). */
function priceAt(o: Raw, issues: Issue[], path: string[], optional: boolean): number | undefined {
  const v = o.price_aed;
  if (v === undefined && optional) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1_000_000 || Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) {
    issues.push({ message: "price_aed is a number from 0 to 1,000,000 with at most two decimals", path: [...path, "price_aed"] });
    return undefined;
  }
  return Math.round(v * 100);
}

const idAt = (raw: Raw, issues: Issue[]): string | undefined => {
  const v = raw.id;
  if (typeof v !== "string" || !BRANCH_ID.test(v.trim())) {
    issues.push({ message: "id is a branch id (list_branches)", path: ["id"] });
    return undefined;
  }
  return v.trim();
};

const str = (description: string, max: number, min = 1) => ({ type: "string", minLength: min, maxLength: max, description });

// ------------------------------------------------------------------ schemas

export const NO_INPUT = { type: "object", properties: {}, additionalProperties: false };

/** The parse of a tool with no input: any property is an issue. */
export function noProperties(raw: Raw, issues: Issue[]): Record<string, never> {
  noExtra(raw, [], issues);
  return {};
}

export const SETTINGS_PATCH_JSON = {
  type: "object",
  properties: {
    settings: {
      type: "object",
      minProperties: 1,
      properties: {
        brand_name: str("The company's name on pages, PDFs and messages", 80),
        brand_color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$", description: "The brand colour as #RRGGBB" },
        sender_name: str("The name messages and emails come from", 80),
        accounts_email: { type: "string", format: "email", maxLength: 254, description: "Where the nightly summary goes" },
        footers: {
          type: "object",
          minProperties: 1,
          properties: { invoice: str("The invoice footer; empty clears it", 500, 0), quote: str("The quotation footer; empty clears it", 500, 0), job_card: str("The job card footer; empty clears it", 500, 0) },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  required: ["settings"],
  additionalProperties: false,
};

export interface SettingsPatch {
  brand_name?: string;
  brand_color?: string;
  sender_name?: string;
  accounts_email?: string;
  footers?: { invoice?: string; quote?: string; job_card?: string };
}

export function parseSettingsPatch(raw: Raw, issues: Issue[]): { settings: SettingsPatch } {
  noExtra(raw, ["settings"], issues);
  const s = objectAt(raw, "settings", ["brand_name", "brand_color", "sender_name", "accounts_email", "footers"], issues);
  const out: SettingsPatch = {};
  if (s === undefined) return { settings: out };
  if (Object.keys(s).length === 0) issues.push({ message: "settings needs at least one key", path: ["settings"] });
  const p = ["settings"];
  const name = text(s, "brand_name", 1, 80, issues, p, true);
  if (name !== undefined) out.brand_name = name;
  if (s.brand_color !== undefined) {
    if (typeof s.brand_color === "string" && COLOR.test(s.brand_color.trim())) out.brand_color = s.brand_color.trim();
    else issues.push({ message: "brand_color is #RRGGBB", path: [...p, "brand_color"] });
  }
  const sender = text(s, "sender_name", 1, 80, issues, p, true);
  if (sender !== undefined) {
    if (/[<>\r\n]/u.test(sender)) issues.push({ message: "sender_name has no < > or line break", path: [...p, "sender_name"] });
    else out.sender_name = sender;
  }
  if (s.accounts_email !== undefined) {
    if (typeof s.accounts_email === "string" && s.accounts_email.trim().length <= 254 && EMAIL.test(s.accounts_email.trim())) out.accounts_email = s.accounts_email.trim();
    else issues.push({ message: "accounts_email is an email address", path: [...p, "accounts_email"] });
  }
  if (s.footers !== undefined) {
    const f = objectAt(s, "footers", ["invoice", "quote", "job_card"], issues, p);
    if (f !== undefined) {
      if (Object.keys(f).length === 0) issues.push({ message: "footers needs at least one key", path: [...p, "footers"] });
      const footers: NonNullable<SettingsPatch["footers"]> = {};
      for (const k of ["invoice", "quote", "job_card"] as const) {
        const t = text(f, k, 0, 500, issues, [...p, "footers"], true);
        if (t !== undefined) footers[k] = t;
      }
      out.footers = footers;
    }
  }
  return { settings: out };
}

/** The app__settings keys a patch writes: the footers have a key of their own each. */
export function patchEntries(patch: SettingsPatch): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["brand_name", "brand_color", "sender_name", "accounts_email"] as const) if (patch[k] !== undefined) out[k] = patch[k] as string;
  if (patch.footers?.invoice !== undefined) out.footer_invoice = patch.footers.invoice;
  if (patch.footers?.quote !== undefined) out.footer_quote = patch.footers.quote;
  if (patch.footers?.job_card !== undefined) out.footer_job_card = patch.footers.job_card;
  return out;
}

export const LOGO_JSON = {
  type: "object",
  properties: {
    image: { type: "string", minLength: 4, maxLength: MAX_LOGO_BASE64, description: "The logo, base64 encoded, at most 512 KiB decoded (PNG, JPEG or SVG)" },
    content_type: { type: "string", enum: [...LOGO_TYPES] },
  },
  required: ["image", "content_type"],
  additionalProperties: false,
};

export function parseLogo(raw: Raw, issues: Issue[]): { image: string; content_type: LogoType } {
  noExtra(raw, ["image", "content_type"], issues);
  const image = typeof raw.image === "string" ? raw.image.trim() : "";
  if (image.length < 4 || image.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(image)) issues.push({ message: "image is base64", path: ["image"] });
  else if (decodedLength(image) > MAX_LOGO_BYTES) issues.push({ message: "image is at most 512 KiB decoded", path: ["image"] });
  const type = raw.content_type;
  if (typeof type !== "string" || !(LOGO_TYPES as readonly string[]).includes(type)) issues.push({ message: `content_type is one of ${LOGO_TYPES.join(", ")}`, path: ["content_type"] });
  return { image, content_type: type as LogoType };
}

/** The decoded size of a base64 string of valid shape (length a multiple of 4, padding at the end). */
const decodedLength = (b64: string): number => (b64.length / 4) * 3 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** What the bytes are, by their content and not by what was declared: PNG and JPEG by their magic bytes, SVG by its root element. Null for anything else. */
export function sniffLogo(bytes: Uint8Array): LogoType | null {
  const at = (...sig: number[]): boolean => sig.every((b, i) => bytes[i] === b);
  if (at(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0xff, 0xd8, 0xff)) return "image/jpeg";
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, Math.min(bytes.length, 4096))).replace(/^﻿/u, "");
  } catch {
    return null;
  }
  return /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/iu.test(source) ? "image/svg+xml" : null;
}

export const BRANCH_ADD_JSON = {
  type: "object",
  properties: { branch: { type: "object", properties: { name: str("The branch's name", 80), emirate: { type: "string", enum: [...EMIRATES] } }, required: ["name", "emirate"], additionalProperties: false } },
  required: ["branch"],
  additionalProperties: false,
};

export function parseBranchAdd(raw: Raw, issues: Issue[]): { branch: { name: string; emirate: string } } {
  noExtra(raw, ["branch"], issues);
  const b = objectAt(raw, "branch", ["name", "emirate"], issues) ?? {};
  return { branch: { name: text(b, "name", 1, 80, issues, ["branch"], false) ?? "", emirate: emirateAt(b, issues, ["branch"], false) ?? "" } };
}

export const BRANCH_UPDATE_JSON = {
  type: "object",
  properties: {
    id: { type: "string", pattern: "^[a-z0-9_]{1,64}$", description: "The branch's id, from list_branches" },
    branch: { type: "object", minProperties: 1, properties: { name: str("The branch's name", 80), emirate: { type: "string", enum: [...EMIRATES] } }, additionalProperties: false },
  },
  required: ["id", "branch"],
  additionalProperties: false,
};

export function parseBranchUpdate(raw: Raw, issues: Issue[]): { id: string; branch: { name?: string; emirate?: string } } {
  noExtra(raw, ["id", "branch"], issues);
  const id = idAt(raw, issues) ?? "";
  const b = objectAt(raw, "branch", ["name", "emirate"], issues) ?? {};
  if (Object.keys(b).length === 0) issues.push({ message: "branch needs at least one key", path: ["branch"] });
  const out: { name?: string; emirate?: string } = {};
  const name = text(b, "name", 1, 80, issues, ["branch"], true);
  if (name !== undefined) out.name = name;
  const emirate = emirateAt(b, issues, ["branch"], true);
  if (emirate !== undefined) out.emirate = emirate;
  return { id, branch: out };
}

const PRICE = { type: "number", minimum: 0, maximum: 1_000_000, description: "The price in AED, at most two decimals" };

export const SERVICE_ADD_JSON = {
  type: "object",
  properties: { service: { type: "object", properties: { name: str("The service's name", 80), price_aed: PRICE }, required: ["name", "price_aed"], additionalProperties: false } },
  required: ["service"],
  additionalProperties: false,
};

export function parseServiceAdd(raw: Raw, issues: Issue[]): { service: { name: string; price_fils: number } } {
  noExtra(raw, ["service"], issues);
  const s = objectAt(raw, "service", ["name", "price_aed"], issues) ?? {};
  return { service: { name: text(s, "name", 1, 80, issues, ["service"], false) ?? "", price_fils: priceAt(s, issues, ["service"], false) ?? 0 } };
}

export const SERVICE_UPDATE_JSON = {
  type: "object",
  properties: {
    id: { type: "integer", minimum: 1, description: "The service's id, from list_services" },
    service: { type: "object", minProperties: 1, properties: { name: str("The service's name", 80), price_aed: PRICE, active: { type: "boolean" } }, additionalProperties: false },
  },
  required: ["id", "service"],
  additionalProperties: false,
};

export function parseServiceUpdate(raw: Raw, issues: Issue[]): { id: number; service: { name?: string; price_fils?: number; active?: boolean } } {
  noExtra(raw, ["id", "service"], issues);
  const id = raw.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) issues.push({ message: "id is a service id (list_services)", path: ["id"] });
  const s = objectAt(raw, "service", ["name", "price_aed", "active"], issues) ?? {};
  if (Object.keys(s).length === 0) issues.push({ message: "service needs at least one key", path: ["service"] });
  const out: { name?: string; price_fils?: number; active?: boolean } = {};
  const name = text(s, "name", 1, 80, issues, ["service"], true);
  if (name !== undefined) out.name = name;
  const price = priceAt(s, issues, ["service"], true);
  if (price !== undefined) out.price_fils = price;
  if (s.active !== undefined) {
    if (typeof s.active === "boolean") out.active = s.active;
    else issues.push({ message: "active is true or false", path: ["service", "active"] });
  }
  return { id: typeof id === "number" ? id : 0, service: out };
}

// -------------------------------------------------------------- the settings

export interface SettingsView {
  brand_name: string;
  brand_color: string;
  sender_name: string;
  accounts_email: string;
  footers: { invoice: string; quote: string; job_card: string };
  logo: boolean;
  logo_url: string | null;
}

/** The settings the owner connector reads and changes. No secret is among them: app__settings holds the setup's hash and pending list too, and none of those is shown. */
export async function settingsView(db: DbStatements): Promise<SettingsView> {
  const s = await getSettings(db);
  const logo = logoSrc(s);
  return {
    brand_name: s.brand_name ?? "",
    brand_color: s.brand_color ?? "",
    sender_name: s.sender_name ?? "",
    accounts_email: s.accounts_email ?? "",
    footers: { invoice: s.footer_invoice ?? "", quote: s.footer_quote ?? "", job_card: s.footer_job_card ?? "" },
    logo: logo !== null,
    logo_url: logo,
  };
}

/** Whether a module service failed because the call has no signed-in session (`auth.currentSession` reads a request's cookie; a tool call has none). */
export const isNoSession = (e: unknown): boolean => (e as { code?: string } | null)?.code === "RENOX_MODULE_SERVICE" && String((e as Error).message).includes("auth.currentSession");

/** The roles of the contract (`invite_people`): the app's `branch_manager` is `manager` there. */
export const contractRole = (role: string | undefined): string | null => (role === undefined || role === "" ? null : role === "branch_manager" ? "manager" : role);
