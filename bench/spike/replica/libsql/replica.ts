// An embedded replica on "host 2" (#256): a local file that @libsql/client
// keeps in sync with the `sqld` primary until killed: sync() again at once
// while it brings frames (one call pulls a bounded batch), otherwise every
// <interval> ms. The file is plain SQLite: the RPO check reads it directly.
//
//   bun replica.ts <replica file> <primary url> <interval ms>
import { createClient } from "@libsql/client";

const [file, syncUrl, intervalArg] = process.argv.slice(2) as [string, string, string];
const db = createClient({ url: `file:${file}`, syncUrl });
for (;;) {
  let frames = 0;
  try {
    frames = (await db.sync())?.frames_synced ?? 0;
  } catch {
    // The primary is gone (the kill): keep the file as it is.
  }
  if (frames === 0) await Bun.sleep(Number(intervalArg));
}
