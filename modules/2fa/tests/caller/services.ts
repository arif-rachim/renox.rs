// Test only (#769): what a caller in another module sees of a twofa error.
import { twofa } from "renox:modules";

type Seen = { code: unknown; cause_code: unknown; cause_details: unknown; message: string } | { returned: true };

export async function stepUp(_ctx: unknown, next: string): Promise<Seen> {
  try {
    await twofa.requireRecent({ within: 5, next });
    return { returned: true };
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown; details?: { cause_code?: unknown; cause_details?: unknown } };
    return { code: err.code, cause_code: err.details?.cause_code ?? null, cause_details: err.details?.cause_details ?? null, message: String(err.message) };
  }
}
