// The company's settings (app__settings): branding for the layout, PDFs and mails.
import type { DbStatements } from "@renoxium/sdk";

export type Settings = Record<string, string>;

/** Every setting as a key to value map. The statement is constant. */
export async function getSettings(db: DbStatements): Promise<Settings> {
  const rows = await db.query<{ key: string; value: string }>("select key, value from app__settings", []);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

const COLOR = /^#[0-9a-fA-F]{6}$/u;

/** The brand colour when it is a #rrggbb value, else the platform's coral. */
export function brandColor(settings: Settings): string {
  const c = settings.brand_color ?? "";
  return COLOR.test(c) ? c : "#e8634a";
}
