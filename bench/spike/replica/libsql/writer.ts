// The writer.ts load against a libSQL primary (#256): the same insert of
// ≈ 230 bytes per transaction, sent to `sqld` over HTTP (Hrana) with
// @libsql/client, the way a cell on libSQL would write. Prints the same
// JSON as ../writer.ts.
//
//   bun writer.ts <primary url> <seconds> [--ack-file <path>] [--rate <writes per second>]
import { createClient } from "@libsql/client";
import { fsyncSync, ftruncateSync, openSync, writeSync } from "node:fs";

const [url, secondsArg, ...rest] = process.argv.slice(2) as [string, string, ...string[]];
const seconds = Number(secondsArg);
const ackIdx = rest.indexOf("--ack-file");
const ackPath = ackIdx >= 0 ? rest[ackIdx + 1] : undefined;
const ackFd = ackPath ? openSync(ackPath, "w") : undefined;
// --rate: at most this many writes per second (0 or absent: as fast as the file allows).
const rateIdx = rest.indexOf("--rate");
const rate = rateIdx >= 0 ? Number(rest[rateIdx + 1]) : 0;

const db = createClient({ url });
await db.execute("create table if not exists app__hits (id integer primary key, at integer not null, pad text not null)");
const pad = "x".repeat(200);
const lat: number[] = [];
let last = 0;
let lastSync = performance.now();
const begin = performance.now();
const end = begin + seconds * 1000;
while (performance.now() < end) {
  const t0 = performance.now();
  const r = await db.execute({ sql: "insert into app__hits (at, pad) values (?, ?) returning id", args: [Date.now(), pad] });
  lat.push(performance.now() - t0);
  last = Number(r.rows[0]?.id ?? last);
  if (ackFd !== undefined && performance.now() - lastSync > 50) {
    ftruncateSync(ackFd, 0);
    writeSync(ackFd, String(last), 0);
    fsyncSync(ackFd);
    lastSync = performance.now();
  }
  if (rate > 0) {
    const next = begin + (lat.length * 1000) / rate;
    const wait = next - performance.now();
    if (wait > 0) await Bun.sleep(wait);
  }
}
lat.sort((a, b) => a - b);
const pct = (p: number) => lat[Math.min(lat.length - 1, Math.ceil((p / 100) * lat.length) - 1)] as number;
console.log(JSON.stringify({ writes: lat.length, writes_per_s: seconds > 0 ? lat.length / seconds : 0, p50_ms: pct(50), p99_ms: pct(99), last_id: last }));
db.close();
