// bun run bump-version [--dry-run] [--yes] [--skip-tests]
//
// The release wizard. Reads the state of the repository (what changed in the
// worker and in the CLI/SDK since their last tags, a worker release the CLI
// does not pin yet, a CLI version on main without its tag, a worker CI run
// still going) and offers what makes sense: worker + CLI, worker only, CLI
// only, pin a released worker, tag a release commit. The first option is the
// recommendation.
//
// --dry-run   shows the state, the options and what the recommendation would
//             do (with the drafted CHANGELOG notes); changes nothing.
// --yes       takes the recommendation, patch versions and the drafted notes.
//
// Worker + CLI waits for release-worker.yml (about 80 minutes). If the wait
// breaks (closed terminal, sleep), run bump-version again: it sees the
// released worker that is not pinned yet and goes on from there.

import { cargoVersion, releaseWorker } from "./bump-worker.ts";
import { pkgVersion, releaseCli, tagCli } from "./bump-cli.ts";
import { pinWorker, pinnedVersion, releaseNotReady } from "./pin-worker.ts";
import {
  type Flags,
  choose,
  cli,
  commitsSince,
  compare,
  confirm,
  editText,
  git,
  lastTag,
  nextVersion,
  parseFlags,
  preflight,
  read,
  run,
  unreleasedBody,
} from "./lib.ts";

/** What release-worker.yml builds from (its tag must match crates/renox-cell). */
export const WORKER_PATHS = ["crates", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml"];
/** What release-cli.yml and release-sdk.yml ship. */
export const CLI_PATHS = ["cli", "sdk"];

type Run = { id: number; status: string; conclusion: string; url: string };

interface State {
  workerTag: string | null;
  cargo: string;
  pinned: string;
  workerCommits: string[];
  /** The newest worker tag when the CLI does not pin it yet. */
  pending: { version: string; run: Run | null; ready: boolean } | null;
  cliTag: string | null;
  cliVersion: string;
  cliUntagged: boolean;
  cliCommits: string[];
}

const workerRun = (tag: string): Run | null => {
  const p = Bun.spawnSync(
    ["gh", "run", "list", "--workflow", "release-worker.yml", "--branch", tag, "-L", "1", "--json", "databaseId,status,conclusion,url"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) return null;
  const runs = JSON.parse(new TextDecoder().decode(p.stdout) || "[]") as { databaseId: number; status: string; conclusion: string; url: string }[];
  const r = runs[0];
  return r ? { id: r.databaseId, status: r.status, conclusion: r.conclusion, url: r.url } : null;
};

const version = (tag: string | null, prefix: string): string | null => (tag ? tag.slice(prefix.length) : null);

export const detect = (): State => {
  git("fetch", "--quiet", "origin", "main", "--tags");
  const workerTag = lastTag("worker-v");
  const cliTag = lastTag("cli-v");
  const pinned = pinnedVersion();
  const wv = version(workerTag, "worker-v");
  let pending: State["pending"] = null;
  if (wv && compare(wv, pinned) > 0) {
    const tag = `worker-v${wv}`;
    pending = { version: wv, run: workerRun(tag), ready: releaseNotReady(tag) === null };
  }
  const cliVersion = pkgVersion("cli/package.json");
  const cv = version(cliTag, "cli-v");
  return {
    workerTag,
    cargo: cargoVersion(),
    pinned,
    workerCommits: commitsSince(workerTag, WORKER_PATHS),
    pending,
    cliTag,
    cliVersion,
    cliUntagged: cv !== null && compare(cliVersion, cv) > 0 && !git("tag", "--list", `cli-v${cliVersion}`),
    cliCommits: commitsSince(cliTag, CLI_PATHS),
  };
};

const SKIP = /^(Merge |Release (cli|worker)-v|Pin renox-worker )/u;

/** The CHANGELOG body for the next CLI release: the unreleased entry if there is one, else a draft from the commits. */
export const draftNotes = (state: State, pinLine: string | null): string => {
  let body = unreleasedBody(read("CHANGELOG.md"));
  if (!body) {
    const commits = state.cliCommits.filter((s) => !SKIP.test(s));
    body = [
      `CLI and SDK changes since ${state.cliTag ?? "the first release"}.`,
      "",
      "**Changes**",
      "",
      ...(commits.length ? commits.map((s) => `- ${s}`) : ["- (no CLI or SDK commits)"]),
    ].join("\n");
  }
  if (pinLine && !body.includes(pinLine))
    body = body.includes("**Worker**\n\n")
      ? body.replace("**Worker**\n\n", `**Worker**\n\n${pinLine}\n`)
      : `${body}\n\n**Worker**\n\n${pinLine}`;
  return body;
};

interface Option {
  label: string;
  steps: string[];
  /** The CLI release takes notes (and so asks for them before anything runs). */
  cliRelease: boolean;
  /** Worker version the CLI release will pin, for the CHANGELOG line. */
  pins: (s: State, workerArg: string) => string | null;
  needsWorkerBump: boolean;
  act: (ctx: Ctx) => void;
}

interface Ctx {
  state: State;
  flags: Flags;
  workerArg: string;
  cliArg: string;
  notes: string | null;
}

const MINUTE = 60_000;

/** Waits for release-worker.yml on `tag` to finish green and its release to carry the checksums. */
const waitForWorker = (tag: string): void => {
  console.log(`\nwaiting for release-worker.yml on ${tag} (about 80 minutes).`);
  console.log("If this breaks, run bun run bump-version again: it goes on from the release.\n");
  let r: Run | null = null;
  for (let i = 0; i < 20 && !r; i++) {
    r = workerRun(tag);
    if (!r) Bun.sleepSync(15_000);
  }
  if (!r) throw new Error(`no release-worker.yml run for ${tag} after 5 minutes; check the Actions tab`);
  console.log(`run: ${r.url}`);
  const start = Date.now();
  while (r.status !== "completed") {
    Bun.sleepSync(MINUTE);
    r = workerRun(tag) ?? r;
    console.log(`  ${Math.round((Date.now() - start) / MINUTE)} min: ${r.status}`);
  }
  if (r.conclusion !== "success") throw new Error(`release-worker.yml ${r.conclusion} for ${tag}: ${r.url}`);
  for (let i = 0; i < 20 && releaseNotReady(tag); i++) Bun.sleepSync(30_000);
  const notReady = releaseNotReady(tag);
  if (notReady) throw new Error(notReady);
  console.log(`${tag} is released.`);
};

/** Tags the worker version crates/renox-cell already carries on main and pushes the tag. */
const tagWorker = (v: string, flags: Flags): void => {
  const tag = `worker-v${v}`;
  preflight(tag, flags);
  run(["git", "tag", "-a", tag, "-m", tag]);
  run(["git", "push", "origin", tag]);
};

export const options = (s: State): Option[] => {
  const out: Option[] = [];
  const noPin = (): null => null;
  const pinThen = (v: string, withCli: boolean): Option["act"] => (ctx) => {
    pinWorker(v, ctx.flags);
    if (withCli) releaseCli(ctx.cliArg, ctx.flags, ctx.notes ?? undefined);
  };

  if (s.cliUntagged)
    out.push({
      label: `Tag cli-v${s.cliVersion}: the release commit is on main without its tag`,
      steps: [`tag cli-v${s.cliVersion} on main and push it (runs release-cli.yml and release-sdk.yml)`],
      cliRelease: false,
      pins: noPin,
      needsWorkerBump: false,
      act: (ctx) => tagCli(s.cliVersion, ctx.flags),
    });

  const wv = version(s.workerTag, "worker-v");
  if (wv && compare(s.cargo, wv) > 0)
    out.push({
      label: `Tag worker-v${s.cargo}: crates/renox-cell is at ${s.cargo} without its tag, then pin it and release the CLI`,
      steps: [`tag worker-v${s.cargo} and push it`, "wait for release-worker.yml", `pin ${s.cargo} in the CLI`, "release the CLI + SDK"],
      cliRelease: true,
      pins: () => s.cargo,
      needsWorkerBump: false,
      act: (ctx) => {
        tagWorker(s.cargo, ctx.flags);
        waitForWorker(`worker-v${s.cargo}`);
        pinThen(s.cargo, true)(ctx);
      },
    });

  if (s.pending) {
    const { version: v, run: r, ready } = s.pending;
    if (ready) {
      out.push(
        {
          label: `Pin worker ${v} (released, the CLI pins ${s.pinned}) and release the CLI`,
          steps: [`pin ${v} in the CLI, push to main`, "release the CLI + SDK"],
          cliRelease: true,
          pins: () => v,
          needsWorkerBump: false,
          act: pinThen(v, true),
        },
        {
          label: `Pin worker ${v} only`,
          steps: [`pin ${v} in the CLI, push to main (no CLI release)`],
          cliRelease: false,
          pins: noPin,
          needsWorkerBump: false,
          act: pinThen(v, false),
        },
      );
    } else if (r && r.status !== "completed") {
      out.push({
        label: `Wait for worker ${v} (release-worker.yml is ${r.status}), then pin it and release the CLI`,
        steps: [`wait for ${r.url}`, `pin ${v} in the CLI`, "release the CLI + SDK"],
        cliRelease: true,
        pins: () => v,
        needsWorkerBump: false,
        act: (ctx) => {
          waitForWorker(`worker-v${v}`);
          pinThen(v, true)(ctx);
        },
      });
    } else {
      console.warn(`warning: worker-v${v} has no usable release (${r ? `run ${r.conclusion}: ${r.url}` : "no run found"}); fix it, then release a new worker version`);
    }
  }

  const worker: Option[] = [
    {
      label: "Worker + CLI: release a new worker, wait for its CI, pin it, release the CLI",
      steps: ["bump crates/renox-cell, tag worker-v<next>, push", "wait for release-worker.yml (~80 min)", "pin it in the CLI", "release the CLI + SDK"],
      cliRelease: true,
      pins: (st, arg) => nextVersion(st.cargo, arg),
      needsWorkerBump: true,
      act: (ctx) => {
        const v = releaseWorker(ctx.workerArg, ctx.flags);
        waitForWorker(`worker-v${v}`);
        pinThen(v, true)(ctx);
      },
    },
    {
      label: "Worker only: release a new worker (pin it later with bump-version)",
      steps: ["bump crates/renox-cell, tag worker-v<next>, push"],
      cliRelease: false,
      pins: noPin,
      needsWorkerBump: true,
      act: (ctx) => void releaseWorker(ctx.workerArg, ctx.flags),
    },
  ];
  const cliOnly: Option = {
    label: `CLI only: release the CLI + SDK (pins worker ${s.pinned})`,
    steps: ["bump the CLI + SDK, date the CHANGELOG, tag cli-v<next>, push"],
    cliRelease: true,
    pins: noPin,
    needsWorkerBump: false,
    act: (ctx) => void releaseCli(ctx.cliArg, ctx.flags, ctx.notes ?? undefined),
  };
  // Changes decide the order: what changed comes first.
  if (s.workerCommits.length && !s.pending) out.push(...worker, cliOnly);
  else out.push(cliOnly, ...worker);
  return out;
};

/** Nothing changed and nothing is half done: the recommendation is to stop. */
export const nothingToRelease = (s: State): boolean => {
  const wv = version(s.workerTag, "worker-v");
  const workerUntagged = wv !== null && compare(s.cargo, wv) > 0;
  return !s.cliUntagged && !workerUntagged && !s.pending && !s.workerCommits.length && !s.cliCommits.length;
};

const showState = (s: State): void => {
  console.log("Release state");
  console.log(`  worker: last tag ${s.workerTag ?? "-"}, crates/renox-cell ${s.cargo}, the CLI pins ${s.pinned}`);
  console.log(`          ${s.workerCommits.length} commit(s) on ${WORKER_PATHS.join(", ")} since ${s.workerTag ?? "the start"}`);
  for (const c of s.workerCommits.slice(-8)) console.log(`            - ${c}`);
  if (s.pending) console.log(`          worker-v${s.pending.version}: ${s.pending.ready ? "released, not pinned" : s.pending.run ? `run ${s.pending.run.status} ${s.pending.run.conclusion}` : "no run found"}`);
  console.log(`  cli/sdk: last tag ${s.cliTag ?? "-"}, package.json ${s.cliVersion}${s.cliUntagged ? " (not tagged yet)" : ""}`);
  console.log(`          ${s.cliCommits.length} commit(s) on ${CLI_PATHS.join(", ")} since ${s.cliTag ?? "the start"}`);
  for (const c of s.cliCommits.slice(-8)) console.log(`            - ${c}`);
};

const bumpChoice = (what: string, current: string, flags: Flags): string => {
  const kinds = ["patch", "minor", "major"];
  if (flags.yes || flags.dryRun) return "patch";
  return kinds[choose(`${what} version (now ${current}):`, kinds.map((k) => `${k} -> ${nextVersion(current, k)}`))]!;
};

/** Shows the drafted notes; lets the user take them, edit them in the git editor, or stop. */
const reviewNotes = (notes: string, flags: Flags): string => {
  let text = notes;
  for (;;) {
    console.log(`\nCHANGELOG notes for the CLI release:\n${"-".repeat(60)}\n${text}\n${"-".repeat(60)}`);
    if (flags.yes || flags.dryRun) return text;
    const c = choose("Notes:", ["use them", "edit them in the editor", "abort"]);
    if (c === 0) return text;
    if (c === 2) throw new Error("aborted");
    text = editText(text).trim();
  }
};

if (import.meta.main) cli(() => {
  const flags = parseFlags(process.argv.slice(2));
  const state = detect();
  showState(state);
  const opts = options(state);
  const idle = nothingToRelease(state);
  // The recommendation is listed first; with nothing to release it is Abort.
  const menu: (Option | null)[] = idle ? [null, ...opts] : [...opts, null];
  const labels = menu.map((o, i) => `${o ? o.label : "Abort"}${i === 0 ? " (recommended)" : ""}`);
  if (idle) console.log("\nNothing to release: no worker, CLI or SDK commit since the last tags.");

  let pick = 0;
  if (flags.dryRun) {
    console.log("\nOptions:");
    labels.forEach((l, i) => console.log(`  ${i + 1}) ${l}`));
    if (idle) return console.log("\ndry run: the recommendation is to release nothing.");
  } else if (!flags.yes) {
    pick = choose("What to release?", labels);
  } else if (idle) {
    return console.log("--yes: nothing to release.");
  }
  const opt = menu[pick];
  if (!opt) throw new Error("aborted");

  const workerArg = opt.needsWorkerBump ? bumpChoice("Worker", state.cargo, flags) : "patch";
  const cliArg = opt.cliRelease ? bumpChoice("CLI + SDK", state.cliVersion, flags) : "patch";
  const pin = opt.pins(state, workerArg);
  const notes = opt.cliRelease ? reviewNotes(draftNotes(state, pin ? `- Pins \`renox-worker\` ${pin}.` : null), flags) : null;

  console.log(`\nPlan: ${opt.label}`);
  if (opt.needsWorkerBump) console.log(`  worker ${state.cargo} -> ${nextVersion(state.cargo, workerArg)}`);
  if (opt.cliRelease) console.log(`  CLI + SDK ${state.cliVersion} -> ${nextVersion(state.cliVersion, cliArg)}`);
  opt.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));

  if (flags.dryRun) return console.log("\ndry run: nothing changed, committed, tagged or pushed.");
  preflight(null, flags);
  confirm("Run this plan? (each step pushes to main)", flags);
  // The plan is confirmed: the steps run without asking again (the wait can be long).
  opt.act({ state, flags: { ...flags, yes: true }, workerArg, cliArg, notes });
  console.log("\ndone.");
});
