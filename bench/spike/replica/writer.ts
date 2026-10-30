// Write-heavy load against one SQLite file in WAL mode (#256), the same
// shape for every candidate: one insert of ~230 bytes per transaction,
// as fast as the file allows, for a fixed time. Prints JSON: writes/s,
// p50/p99 per write, and the id of the last acknowledged row (for RPO:
// the replica is compared with it after a SIGKILL).
//
//   bun writer.ts <db file> <seconds> [--ack-file <path>] [--rate <writes per second>]
//
// --ack-file: the last acknowledged id is written there after every
// commit (fsync'd every 50 ms), so a killed writer leaves its last ack.
import { Database } from "bun:sqlite";
import { openSync, writeSync, ftruncateSync, fsyncSync } from "node:fs";

const [file, secondsArg, ...rest] = process.argv.slice(2) as [string, string, ...string[]];
const seconds = Number(secondsArg);
const ackIdx = rest.indexOf("--ack-file");
const ackPath = ackIdx >= 0 ? rest[ackIdx + 1] : undefined;
const ackFd = ackPath ? openSync(ackPath, "w") : undefined;
// --rate: at most this many writes per second (0 or absent: as fast as the file allows).
const rateIdx = rest.indexOf("--rate");
const rate = rateIdx >= 0 ? Number(rest[rateIdx + 1]) : 0;

const db = new Database(file, { create: true });
db.exec("pragma journal_mode = wal; pragma synchronous = normal; pragma busy_timeout = 5000;");
db.exec("create table if not exists app__hits (id integer primary key, at integer not null, pad text not null)");
const insert = db.prepare("insert into app__hits (at, pad) values (?, ?) returning id");
const pad = "x".repeat(200);
const lat: number[] = [];
let last = 0;
let lastSync = performance.now();
const begin = performance.now();
const end = begin + seconds * 1000;
while (performance.now() < end) {
  const t0 = performance.now();
  const row = insert.get(Date.now(), pad) as { id: number };
  lat.push(performance.now() - t0);
  last = row.id;
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
