// The billing rollup and the failure alerts are wired (#450). Before this,
// nothing ran control/billing, so meters_hourly stayed empty and usage,
// quotas and invoices saw zero; a failed nightly backup told no one. The
// rollup itself (meters_raw to meters_hourly) is control/billing's
// tests/billing.test.ts ("runOnce"); `systemd-analyze verify` over these
// units is ops/scripts/verify-units.sh. docs/23-failure-modes.md has no row
// for a failed control-plane backup or rollup yet; the PR proposes one.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const REPO = join(HERE, "../..");
const unit = (name: string): string => readFileSync(join(HERE, name), "utf8");
const key = (text: string, k: string): string[] => [...text.matchAll(new RegExp(`^${k}=(.*)$`, "gmu"))].map((m) => m[1] as string);

test("renox-billing.service runs one pass of control/billing with the control API's user and settings", () => {
  const s = unit("renox-billing.service");
  expect(key(s, "Type")).toEqual(["oneshot"]);
  const [exec] = key(s, "ExecStart");
  expect(exec).toBe("/opt/renox/bin/bun /opt/renox/src/control/billing/src/main.ts --once");
  // The path is this repository's (deployed to /opt/renox/src) and main.ts knows --once.
  const main = join(REPO, "control/billing/src/main.ts");
  expect(existsSync(main)).toBe(true);
  expect(readFileSync(main, "utf8")).toContain('process.argv.includes("--once")');
  const control = unit("renox-control.service");
  for (const k of ["User", "Group", "EnvironmentFile"]) expect([k, key(s, k)]).toEqual([k, key(control, k)]);
  expect(key(s, "OnFailure")).toEqual(["renox-alert@%n.service"]);
});

test("renox-billing.timer runs it every hour and catches up after downtime", () => {
  const t = unit("renox-billing.timer");
  expect(key(t, "OnCalendar")).toEqual(["*-*-* *:07:00"]);
  expect(key(t, "Persistent")).toEqual(["true"]);
  expect(key(t, "WantedBy")).toEqual(["timers.target"]);
});

test("a failed backup or rollup starts renox-alert@, which reads its webhook from a credential", () => {
  expect(key(unit("renox-backup-db.service"), "OnFailure")).toEqual(["renox-alert@%n.service"]);
  const a = unit("renox-alert@.service");
  expect(key(a, "ExecStart")).toEqual(["/opt/renox/bin/renox-alert.sh %i"]);
  expect(key(a, "LoadCredential")).toEqual(["alert.env:/etc/renox/secrets/alert.env"]);
  expect(existsSync(join(HERE, "../scripts/renox-alert.sh"))).toBe(true);
  expect(readFileSync(join(HERE, "../scripts/bootstrap-node.sh"), "utf8")).toContain('"$here/scripts/renox-alert.sh" "$bin_dir/renox-alert.sh"');
});

test("the runbook installs both and checks them", () => {
  const runbook = readFileSync(join(HERE, "../single-host.md"), "utf8");
  expect(runbook).toContain("systemctl enable --now renox-billing.timer");
  expect(runbook).toContain("/etc/renox/secrets/alert.env");
  expect(runbook).toContain("select max(hour) from meters_hourly");
});

test("Alertmanager has a real receiver whose URL lives outside the repository", () => {
  const am = readFileSync(join(HERE, "../observability/alertmanager.yml"), "utf8");
  expect(am).toContain("url_file: /etc/alertmanager/secrets/webhook_url");
  expect(am).not.toMatch(/^\s*-\s*name:\s*default\s*$/mu);
  expect(am).not.toMatch(/https:\/\/hooks\./u);
});

test("the key-rotation procedure warns not to run it until the re-encryption job exists", () => {
  const keys = readFileSync(join(HERE, "../security/keys.md"), "utf8");
  const at = keys.indexOf("### Master key");
  expect(keys.slice(at, at + 400)).toContain("DO NOT RUN THIS PROCEDURE YET");
  expect(keys).toContain("#451");
});
