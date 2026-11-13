// The email module's templates (#328): each one in English and Arabic, side
// by side in one message (an `ltr` block and an `rtl` block, each with its
// `lang` and `dir`), the recipient's locale first. The subject is in the
// recipient's locale. Every value is HTML-escaped in the HTML part; the text
// part carries both languages too. `email.before_send` lets the app stop a
// message; a different wording is a new template here.

export type Locale = "en" | "ar";

interface Text {
  subject: string;
  /** Paragraphs; `{name}` is replaced by the escaped value of `data.name`. */
  body: string[];
  /** The button's label, when the template has a `url`. */
  action?: string;
}

export const TEMPLATES: Record<string, Record<Locale, Text>> = {
  verify_email: {
    en: { subject: "Confirm your email address", body: ["Hello {display_name},", "Confirm your address to finish signing up. The link works once, for {expires_minutes} minutes."], action: "Confirm my address" },
    ar: { subject: "أكّد عنوان بريدك الإلكتروني", body: ["مرحبًا {display_name}،", "أكّد عنوانك لإكمال التسجيل. يعمل الرابط مرة واحدة لمدة {expires_minutes} دقيقة."], action: "تأكيد عنواني" },
  },
  password_reset: {
    en: { subject: "Reset your password", body: ["Hello {display_name},", "Someone asked to reset the password of this account. If it was you, choose a new one; the link works once, for {expires_minutes} minutes. If it was not, ignore this email."], action: "Choose a new password" },
    ar: { subject: "إعادة تعيين كلمة المرور", body: ["مرحبًا {display_name}،", "طلب أحدهم إعادة تعيين كلمة مرور هذا الحساب. إن كنت أنت، فاختر كلمة جديدة؛ يعمل الرابط مرة واحدة لمدة {expires_minutes} دقيقة. وإن لم تكن أنت، فتجاهل هذه الرسالة."], action: "اختيار كلمة مرور جديدة" },
  },
  magic_link: {
    en: { subject: "Your sign-in link", body: ["Hello {display_name},", "Use this link to sign in. It works once, for {expires_minutes} minutes."], action: "Sign in" },
    ar: { subject: "رابط تسجيل الدخول", body: ["مرحبًا {display_name}،", "استخدم هذا الرابط لتسجيل الدخول. يعمل مرة واحدة لمدة {expires_minutes} دقيقة."], action: "تسجيل الدخول" },
  },
  account_exists: {
    en: { subject: "You already have an account", body: ["Someone tried to sign up with this address, which already has an account. If it was you, sign in or reset your password. Otherwise ignore this email."], action: "Sign in" },
    ar: { subject: "لديك حساب بالفعل", body: ["حاول أحدهم التسجيل بهذا العنوان، وله حساب بالفعل. إن كنت أنت، فسجّل الدخول أو أعد تعيين كلمة المرور. وإلا فتجاهل هذه الرسالة."], action: "تسجيل الدخول" },
  },
  welcome: {
    en: { subject: "Welcome", body: ["Hello {display_name},", "Your account is ready."] },
    ar: { subject: "أهلًا بك", body: ["مرحبًا {display_name}،", "حسابك جاهز."] },
  },
  org_invite: {
    en: { subject: "You are invited to join {org_name}", body: ["{invited_by} invited you to join {org_name} as {role}.", "The invitation expires in {expires_days} days."], action: "Accept the invitation" },
    ar: { subject: "دعوة للانضمام إلى {org_name}", body: ["دعاك {invited_by} للانضمام إلى {org_name} بصفة {role}.", "تنتهي صلاحية الدعوة بعد {expires_days} أيام."], action: "قبول الدعوة" },
  },
};

const esc = (s: string): string => s.replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const fill = (s: string, data: Readonly<Record<string, unknown>>, escape: (v: string) => string): string =>
  s.replace(/\{([a-z_]+)\}/gu, (_, k: string) => escape(typeof data[k] === "string" || typeof data[k] === "number" ? String(data[k]) : ""));

const isLocalhost = (h: string): boolean => h === "localhost" || h.endsWith(".localhost");

/** An origin the module may build links on: https, or http on localhost; nothing else. */
export function cleanOrigin(v: unknown): string | null {
  if (typeof v !== "string" || v === "" || v.length > 200) return null;
  try {
    const u = new URL(v);
    const ok = u.protocol === "https:" || (u.protocol === "http:" && isLocalhost(u.hostname));
    return ok ? u.origin : null;
  } catch {
    return null;
  }
}

/** The `app_url` config as an origin: an https origin only (no path, query, fragment or userinfo), else null. */
export function appUrlOrigin(v: unknown): string | null {
  const o = cleanOrigin(v);
  if (o === null || typeof v !== "string") return null;
  try {
    const u = new URL(v);
    if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "" || u.pathname !== "/" || (v !== o && v !== `${o}/`)) return null;
  } catch {
    return null;
  }
  return o;
}

/** A path of the app itself: one leading `/`, not `//`, no backslash, no control character, at most 2,000 characters. */
export function isAppPath(v: unknown): v is string {
  return typeof v === "string" && v.length <= 2000 && v.startsWith("/") && !v.startsWith("//") && !/[\\\u0000-\u001f\u007f-\u009f]/u.test(v);
}

/**
 * A link is only ever https (or http on localhost, for development). A path
 * of the app (`/org/accept/<token>`, how a module without a request origin
 * writes it) is completed with `base`, the app's own origin; with no base it
 * is dropped. After completing, the origin must equal `base` exactly. Any
 * other relative value is dropped.
 */
export function safeUrl(v: unknown, base: string | null = null): string | null {
  if (typeof v !== "string") return null;
  if (isAppPath(v)) {
    const origin = cleanOrigin(base);
    if (origin === null) return null;
    try {
      const u = new URL(v, origin);
      return u.origin === origin ? u.href : null;
    } catch {
      return null;
    }
  }
  try {
    const u = new URL(v);
    return u.protocol === "https:" || (u.protocol === "http:" && isLocalhost(u.hostname)) ? u.href : null;
  } catch {
    return null;
  }
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

/** `template` with `data` for a recipient in `locale` (`base`: the app's origin that completes a path link); null for an unknown template. */
export function renderMail(template: string, data: Readonly<Record<string, unknown>>, locale: Locale = "en", base: string | null = null): RenderedMail | null {
  const t = TEMPLATES[template];
  if (t === undefined) return null;
  const url = safeUrl(data.url, base);
  const order: Locale[] = locale === "ar" ? ["ar", "en"] : ["en", "ar"];
  const block = (l: Locale): string => {
    const x = t[l];
    const dir = l === "ar" ? "rtl" : "ltr";
    const paras = x.body.map((p) => `<p>${fill(p, data, esc)}</p>`).join("");
    const button = url !== null && x.action !== undefined ? `<p><a href="${esc(url)}">${esc(x.action)}</a></p>` : "";
    return `<td lang="${l}" dir="${dir}" style="vertical-align:top;padding:12px;text-align:${dir === "rtl" ? "right" : "left"}">${paras}${button}</td>`;
  };
  const html = `<!doctype html><html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}"><body><table role="presentation" width="100%"><tr>${order.map(block).join("")}</tr></table></body></html>`;
  const text = order
    .map((l) => [...t[l].body.map((p) => fill(p, data, (v) => v)), ...(url !== null ? [url] : [])].join("\n\n"))
    .join("\n\n----\n\n");
  // The subject takes `{key}` values too, on one line (no header injection).
  return { subject: fill(t[locale].subject, data, (v) => v.replace(/[\r\n]+/gu, " ")), text, html };
}
