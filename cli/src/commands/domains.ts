// renox domains add <hostname> | list | status <hostname> | rm <hostname>   [--app <name>] [--json]
//
// Custom domains (docs/contracts/deploy-api.md section 10, ADR D25): Cloudflare
// for SaaS serves them. `add` claims the hostname and prints the records the
// customer creates at their DNS provider: the CNAME to the platform's edge and
// the two TXT records (ownership and certificate validation). `status` shows
// pending until Cloudflare validates the hostname, then verified; a hostname
// is served only once it is verified. Apex domains have no CNAME: use
// `www.<domain>` and redirect the apex at the registrar.
//
// The hostname is user input: it is checked here for the shape of a DNS name
// (so it cannot alter the request path), and the API's own checks decide the
// rest; its error is shown as it is. No token is ever printed.

import { EXIT, UserError } from "../errors.ts";
import { readProject } from "../lib/project.ts";
import { apiAuth, apiRequest, cliErrorOf, defaultIo, errorBody, type Io } from "./login.ts";

const USAGE = "usage: renox domains add <hostname> | list | status <hostname> | rm <hostname>  [--app <name>] [--json]";
const APP = /^[a-z][a-z0-9-]{0,49}$/u;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u;

interface DnsRecord {
  purpose: string;
  type: string;
  name: string;
  value: string;
}

export interface Domain {
  hostname: string;
  app: string;
  state: string;
  status: string;
  ssl_status: string;
  cname_target: string;
  verification: DnsRecord[];
  created_at: number;
  verified_at: number | null;
  last_checked_at: number | null;
}

/** The hostname lowercased, or a UserError when it is not a DNS name of at least two labels. */
export function normalizeHostname(raw: string): string {
  const h = raw.trim().toLowerCase().replace(/\.$/u, "");
  const labels = h.split(".");
  if (h.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l))) {
    throw new UserError(`${JSON.stringify(raw)} is not a hostname`, { hint: "use a full name such as www.example.com (no scheme, path or port)" });
  }
  return h;
}

async function ok<T>(res: Response, status = 200): Promise<T> {
  if (res.status !== status) throw cliErrorOf(res.status, await errorBody(res));
  return (await res.json()) as T;
}

/** The records to create, as the customer types them at the DNS provider. */
function records(d: Domain): string[] {
  const lines = [`  CNAME  ${d.hostname}  ->  ${d.cname_target}`];
  for (const v of d.verification) lines.push(`  ${v.type.padEnd(5)}  ${v.name}  ->  ${v.value}   (${v.purpose === "ownership" ? "ownership" : "certificate validation"})`);
  return lines;
}

function describe(d: Domain, io: Io): void {
  io.out(`${d.hostname}  ${d.state}  (Cloudflare: ${d.status}, certificate: ${d.ssl_status})`);
  if (d.state === "verified") io.out("  Served. Nothing to do.");
  else if (d.state === "pending") {
    io.out("Create these records at your DNS provider; it can take a few minutes after that:");
    for (const l of records(d)) io.out(l);
    io.out(`Then check with \`renox domains status ${d.hostname}\`. The hostname is not served until it is verified.`);
  }
}

export async function run(args: string[], io: Io = defaultIo(), project: string = process.cwd()): Promise<number> {
  const rest: string[] = [];
  let app: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--app") {
      app = args[++i] ?? "";
      if (!APP.test(app)) throw new UserError(`--app ${JSON.stringify(app)} is not an app name`, { hint: USAGE });
    } else if (a === "--json") json = true;
    else if (a.startsWith("--")) throw new UserError(`unknown argument ${JSON.stringify(a)}`, { hint: USAGE });
    else rest.push(a);
  }
  const [sub, name, ...extra] = rest;
  const needsHost = sub === "add" || sub === "status" || sub === "rm";
  if (sub === undefined || !(needsHost || sub === "list")) throw new UserError(sub === undefined ? "missing subcommand" : `unknown subcommand ${JSON.stringify(sub)}`, { hint: USAGE });
  if (extra.length > 0 || (sub === "list" && name !== undefined)) throw new UserError("too many arguments", { hint: USAGE });
  if (needsHost && name === undefined) throw new UserError("missing hostname", { hint: USAGE });
  const hostname = needsHost ? normalizeHostname(name as string) : "";
  apiAuth(io.env);
  const appName = app ?? readProject(project).app.name;
  const base = `/v1/apps/${appName}/domains`;

  if (sub === "list") {
    const r = await ok<{ domains: Domain[] }>(await apiRequest(io, "GET", base));
    if (json) io.out(JSON.stringify(r));
    else if (r.domains.length === 0) io.out(`No custom domains for ${appName}. Add one with \`renox domains add www.example.com\`.`);
    else for (const d of r.domains) io.out(`${d.hostname.padEnd(40)}  ${d.state.padEnd(9)}  cloudflare ${d.status}, certificate ${d.ssl_status}`);
    return EXIT.OK;
  }
  if (sub === "rm") {
    const d = await ok<Domain>(await apiRequest(io, "DELETE", `${base}/${hostname}`));
    if (json) io.out(JSON.stringify(d));
    else io.out(d.state === "detached" ? `Removed ${d.hostname}: it is no longer served. It stays yours for 30 days, then can be claimed again.` : `Released ${d.hostname}. You can delete its DNS records.`);
    return EXIT.OK;
  }
  const d = sub === "add" ? await ok<Domain>(await apiRequest(io, "POST", base, { json: { hostname } }), 201) : await ok<Domain>(await apiRequest(io, "GET", `${base}/${hostname}`));
  if (json) io.out(JSON.stringify(d));
  else describe(d, io);
  return EXIT.OK;
}
