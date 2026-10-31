// The B17 package list (docs/14-benchmarks.md). One entry per check file; to
// add a package, add its file under checks/ and one line here. Versions must
// equal the exact pins in package.json (tests/registry.test.ts enforces it).
import { check as arctic } from "./arctic.ts";
import { check as checkout } from "./checkout-sdk-node.ts";
import { check as dateFns } from "./date-fns.ts";
import { check as intl } from "./intl.ts";
import { check as nodemailer } from "./nodemailer.ts";
import { check as oslojs } from "./oslojs.ts";
import { check as paytabs } from "./paytabs.ts";
import { check as resend } from "./resend.ts";
import { check as stripe } from "./stripe.ts";
import { check as tabby } from "./tabby.ts";
import { check as telr } from "./telr.ts";
import { check as whatsapp } from "./whatsapp.ts";
import { check as zod } from "./zod.ts";

export type Check = () => Promise<void>;

export interface Entry {
  package: string;
  /** Exact npm version, or "hand-written" / "built-in" when no package is involved. */
  version: string;
  kind: "official" | "hand-written" | "built-in";
  run: Check;
}

export const checks: readonly Entry[] = [
  { package: "stripe", version: "23.0.1", kind: "official", run: stripe },
  { package: "checkout-sdk-node", version: "5.8.0", kind: "official", run: checkout },
  { package: "telr", version: "hand-written", kind: "hand-written", run: telr },
  { package: "paytabs", version: "hand-written", kind: "hand-written", run: paytabs },
  { package: "tabby", version: "hand-written", kind: "hand-written", run: tabby },
  { package: "arctic", version: "3.7.0", kind: "official", run: arctic },
  { package: "@oslojs/crypto+@oslojs/encoding", version: "1.0.1+1.1.0", kind: "official", run: oslojs },
  { package: "whatsapp-cloud-api", version: "hand-written", kind: "hand-written", run: whatsapp },
  { package: "resend", version: "6.35.0", kind: "official", run: resend },
  { package: "nodemailer", version: "10.2.1", kind: "official", run: nodemailer },
  { package: "zod", version: "4.6.7", kind: "official", run: zod },
  { package: "date-fns", version: "4.4.0", kind: "official", run: dateFns },
  { package: "intl", version: "built-in", kind: "built-in", run: intl },
];
