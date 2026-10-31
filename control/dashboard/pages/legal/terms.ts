// The page's locale only (#336, lib/locale.ts): the text is in i18n/.
import type { LoaderContext } from "renox";

import { applyLocale } from "../../lib/locale.ts";

export function load(ctx: LoaderContext) {
  return applyLocale(ctx) ?? {};
}
