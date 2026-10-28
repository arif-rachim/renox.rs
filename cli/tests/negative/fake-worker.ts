// A stand-in for renox-worker in the `renox dev` negative-path tests: reads
// the generated worker.toml, listens where it says, answers `ok <pid>
// <hash>`, records every SIGHUP (route switch) with the hash it switched to
// in hups.log, exits with code 1 on GET /crash, and exits at start while the
// file `crash-on-start` exists next to worker.toml.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const config = process.argv[process.argv.indexOf("--config") + 1] as string;
const state = dirname(config);
if (existsSync(join(state, "crash-on-start"))) process.exit(1);
const { listen } = Bun.TOML.parse(readFileSync(config, "utf8")) as { listen: string };
const [hostname, port] = listen.split(":") as [string, string];
const hash = (): string => {
  const t = JSON.parse(readFileSync(join(state, "routes.json"), "utf8")) as { entries: { deployment_hash: string }[] };
  return t.entries[0]?.deployment_hash ?? "";
};
let current = hash();
process.on("SIGHUP", () => {
  current = hash();
  appendFileSync(join(state, "hups.log"), `${current}\n`);
});
process.on("SIGINT", () => process.exit(0));
Bun.serve({
  hostname,
  port: Number(port),
  fetch(req) {
    if (new URL(req.url).pathname === "/crash") process.exit(1);
    return new Response(`ok ${process.pid} ${current}`);
  },
});
