// The 422 an invalid form answers: the action returns `{ status: 422, values,
// errors, problems }` and the page renders again (its loader runs, the action's
// keys win) with the typed `values` echoed in the form, `errors` keyed by
// field (the message in the page's language) and `problems`, the same list in
// order, which the layouts print as a summary (`id="err-<field>"`). The texts
// are in i18n/en.json and ar.json: `fields.<field>` is a field's label and the
// error keys of lib/forms.ts (`customers.err.name`, ...) are their messages.
import ar from "../i18n/ar.json";
import en from "../i18n/en.json";
import { valuesOf } from "./forms";

type Tree = { [key: string]: string | Tree };
const TEXTS: Record<"en" | "ar", Tree> = { en: en as Tree, ar: ar as Tree };

/** The text at a dotted key, or `undefined`. */
function lookup(lang: "en" | "ar", key: string): string | undefined {
  let node: string | Tree | undefined = TEXTS[lang];
  for (const part of key.split(".")) node = typeof node === "object" ? node[part] : undefined;
  return typeof node === "string" ? node : undefined;
}

/** The label of a field; a line's field is `<name>_<row>` (`qty_2`): the label of the name, with the line number. */
function label(lang: "en" | "ar", field: string): string {
  const m = /^(service|desc|desc_ar|qty|price|site_id|visits)_(\d+)$/u.exec(field);
  if (m === null) return lookup(lang, `fields.${field}`) ?? field;
  const base = lookup(lang, `fields.${m[1] === "desc_ar" ? "desc" : (m[1] as string)}`) ?? field;
  return `${base} (${lookup(lang, "problem.line") ?? "line"} ${Number(m[2]) + 1})`;
}

/**
 * The action result of an invalid form: 422, the typed values and, per field, what is wrong.
 * `which` names the form (`values.form`) when several forms of a page share field names: each reads
 * its values only when `values.form` is its own, so one failed form never fills another.
 */
export function invalid(locale: string, form: FormData, errors: Record<string, string>, which?: string) {
  const lang = locale === "ar" ? "ar" : "en";
  const messages: Record<string, string> = {};
  const problems = Object.entries(errors).map(([field, key]) => {
    const message = lookup(lang, key) ?? key;
    messages[field] = message;
    return { field, label: label(lang, field), message };
  });
  return { status: 422 as const, values: which === undefined ? valuesOf(form) : { ...valuesOf(form), form: which }, errors: messages, problems };
}
