// disk-full: a node's data directory sits on a loop-mounted ext4 file
// system that is filled to each watermark (#103, crate::disk). docs/23 "Disk
// full on node": at 90 % no new cell (a cold tenant gets 503
// RENOX_UNAVAILABLE) while warm tenants still read and write; at 95 % writes
// get 503 RENOX_UNAVAILABLE and reads go on; the other node is unaffected;
// freeing the space restores everything. Needs root, mkfs.ext4 and loop
// mounts; skipped with the reason otherwise.

import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync, statfsSync, writeSync } from "node:fs";
import { join } from "node:path";

import { type Check, type Outcome, verdictOf } from "../lib/result.ts";
import { type Node, Probe, Stack, until } from "../lib/stack.ts";

const ok = (cmd: string, args: string[]): boolean => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;

function canMount(): string | null {
  if (process.getuid?.() !== 0) return "needs root for loop mounts (CI runs this scenario with sudo)";
  if (!ok("mkfs.ext4", ["-V"])) return "mkfs.ext4 is not installed";
  return null;
}

function mountLoop(dir: string): string {
  const image = `${dir}.img`;
  mkdirSync(dir, { recursive: true });
  if (!ok("truncate", ["-s", "128M", image]) || !ok("mkfs.ext4", ["-q", "-m", "0", image]) || !ok("mount", ["-o", "loop", image, dir])) {
    throw new Error(`could not loop-mount ${image}`);
  }
  return image;
}

function usedPct(dir: string): number {
  const s = statfsSync(dir);
  return (100 * (s.blocks - s.bavail)) / s.blocks;
}

/** Writes real blocks into `<dir>/filler` until usage is `pct` percent (0: removes it). */
function fillTo(dir: string, pct: number): void {
  const filler = join(dir, "filler");
  rmSync(filler, { force: true });
  if (pct <= 0) return;
  const s = statfsSync(dir);
  const want = Math.floor((s.blocks * s.bsize * pct) / 100);
  let left = want - (s.blocks - s.bavail) * s.bsize;
  const fd = openSync(filler, "w");
  const chunk = Buffer.alloc(1 << 16);
  while (left > 0) {
    left -= writeSync(fd, chunk, 0, Math.min(chunk.length, left));
  }
  closeSync(fd);
}

export async function run(worker: string): Promise<Outcome> {
  const base: Omit<Outcome, "verdict" | "result" | "checks" | "metrics"> = {
    scenario: "disk-full",
    title: "Disk full on a node",
    failureModes: ["Disk full on node"],
    description: "each node's data directory on a 128 MiB loop-mounted ext4; the victim's filled to 92 %, then 96 %, then emptied (crate::disk polls every 5 s)",
    target: "92 %: a cold tenant 503 RENOX_UNAVAILABLE, warm reads and writes 200; 96 %: writes 503 RENOX_UNAVAILABLE, reads 200; other node unaffected; all 200 after freeing",
    alerts: [
      { rule: "RenoxDiskWatermarkStop", observed: "reads renox_worker_disk_level (pending #295); the level is on /healthz" },
    ],
    notes: [],
  };
  const why = canMount();
  if (why !== null) return { ...base, verdict: "SKIPPED", skipped: why, result: "", checks: [], metrics: {} };

  const scratch = join(process.env.TMPDIR ?? "/tmp", `renox-chaos-disk-${process.pid}`);
  const mounts = [join(scratch, "node-1"), join(scratch, "node-2")];
  const images = mounts.map(mountLoop);
  // Idle cells go after 3 s: activation's health probe (#96) warms every
  // tenant, and the "no new cell" check needs one that is cold again.
  const s = await Stack.start(worker, { dataDirs: mounts.map((m) => join(m, "data")), idleTimeoutSecs: 3 });
  let keep = true;
  try {
    const { victim, victimNode, bystander, bystanderNode, byNode } = await s.place(6);
    const cold = (byNode.get(victimNode.node) ?? []).find((t) => t !== victim) ?? null;
    await Bun.sleep(6_000);
    if ((await s.hit(victimNode, victim, "POST")).status !== 200) throw new Error("warming the victim failed");
    // Keeps the victim warm through the scenario (reads go on at every level).
    const keepWarm = new Probe(s, victimNode, victim, "GET", 1000);
    const mount = mounts[s.nodes.indexOf(victimNode)] as string;
    const level = (n: Node, name: string) =>
      until(`/healthz disk: ${name}`, 30_000, async () => ((await s.health(n))?.reasons?.some((r) => r.startsWith(`disk: ${name}`)) ? true : null));

    fillTo(mount, 92);
    const at92 = usedPct(mount);
    await level(victimNode, "stop_scheduling");
    const coldAt92 = cold === null ? null : await s.hit(victimNode, cold);
    const warmWrite92 = await s.hit(victimNode, victim, "POST");
    const warmRead92 = await s.hit(victimNode, victim);

    fillTo(mount, 96);
    const at96 = usedPct(mount);
    await level(victimNode, "refuse_writes");
    const write96 = await s.hit(victimNode, victim, "POST");
    const read96 = await s.hit(victimNode, victim);
    const otherWrite = bystanderNode === victimNode ? null : await s.hit(bystanderNode, bystander, "POST");

    fillTo(mount, 0);
    await until("/healthz ok", 30_000, async () => ((await s.health(victimNode))?.status === "ok" ? true : null));
    const writeAfter = await s.hit(victimNode, victim, "POST");
    const coldAfter = cold === null ? null : await s.hit(victimNode, cold);
    await keepWarm.stop();

    const checks: Check[] = [
      {
        name: "92 %: no new cell",
        ok: coldAt92 === null || (coldAt92.status === 503 && coldAt92.text.includes("RENOX_UNAVAILABLE")),
        detail: coldAt92 === null ? "no cold tenant on the victim's node" : `cold ${cold?.id}: ${coldAt92.status} (${at92.toFixed(1)} % used)`,
      },
      { name: "92 %: warm tenant reads and writes", ok: warmWrite92.status === 200 && warmRead92.status === 200, detail: `POST ${warmWrite92.status}, GET ${warmRead92.status}` },
      { name: "96 %: writes refused", ok: write96.status === 503 && write96.text.includes("RENOX_UNAVAILABLE"), detail: `POST ${write96.status} (${at96.toFixed(1)} % used)` },
      { name: "96 %: reads go on", ok: read96.status === 200, detail: `GET ${read96.status}` },
      { name: "the other node is unaffected", ok: otherWrite === null || otherWrite.status === 200, detail: otherWrite === null ? "every tenant on one node" : `${bystander.id} on ${bystanderNode.node}: POST ${otherWrite.status}` },
      { name: "freed: everything again", ok: writeAfter.status === 200 && (coldAfter === null || coldAfter.status === 200), detail: `POST ${writeAfter.status}${coldAfter === null ? "" : `, cold GET ${coldAfter.status}`}` },
      { name: "warm reads at every level", ok: keepWarm.failures === 0, detail: `GET once a second on ${victim.id}: ${keepWarm.summary()}` },
    ];
    const out: Outcome = {
      ...base,
      verdict: verdictOf(checks),
      result: checks.map((c) => `${c.name}: ${c.detail}`).join("; "),
      checks,
      metrics: { used_pct_stop: at92, used_pct_refuse: at96 },
    };
    keep = out.verdict === "FAIL";
    if (keep) out.notes.push(`Logs kept in ${s.root}.`);
    return out;
  } catch (e) {
    keep = true;
    throw new Error(`${e instanceof Error ? e.message : String(e)} (logs kept in ${s.root})`);
  } finally {
    await s.stop();
    if (!keep) s.cleanup();
    for (const m of mounts) spawnSync("umount", ["-l", m]);
    for (const i of images) rmSync(i, { force: true });
    // A lazily unmounted directory can stay busy for a moment.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(scratch, { recursive: true, force: true });
        break;
      } catch {
        await Bun.sleep(250);
      }
    }
  }
}
