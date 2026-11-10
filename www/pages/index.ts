// GET /: the landing page of renoxium.com, for the business owner first
// (#675). Every word comes from the copy deck,
// docs/plans/2026-11-09-landing-page-copy.md; this loader holds the parts of
// it the page repeats (the conversation, the four asks, the alternatives, the
// proof, the plans) and the links of lib/contact.ts. No script. The plans come
// from pricing.toml (the pricing page's source), so the page never states a
// price or a quota the billing plans do not have. The proof numbers are the
// measured ones of docs/14-benchmarks.md.
import { LINKS, WAITLIST_FORM } from "../lib/contact.ts";
import { PRICING, quotaText, type PricedPlan } from "../lib/pricing.ts";

/** Numbers that are true and measured (docs/14-benchmarks.md, "F1 results"), with the deck's plain sentence and its link. */
export const STATS: readonly { value: string; unit: string; text: string; link: string; href: string; source: string }[] = [
  {
    value: "107",
    unit: "KB",
    text: "An app that is not being used costs almost nothing to keep running (107 KB of memory), which is why the Free plan can be free and ten apps cost about what one costs elsewhere.",
    link: "How we measured it",
    href: LINKS.benchmarks,
    source: "docs/14-benchmarks.md",
  },
  {
    value: "45",
    unit: "ms",
    text: "Your app answers in under a twentieth of a second even when it has been idle (45 ms at the slowest one in a hundred).",
    link: "How we measured it",
    href: LINKS.benchmarks,
    source: "docs/14-benchmarks.md",
  },
  {
    value: "1",
    unit: "step",
    text: "A change goes live in one step and comes back in seconds if you change your mind.",
    link: "How it works",
    href: "/docs/tenant-lifecycle",
    source: "cli/README.md",
  },
];

/** The six turns of the hero's conversation (deck, section 1): the owner on the end side, Renoxium on the start side. */
export const CONVERSATION: readonly { who: "owner" | "renoxium"; text: string }[] = [
  { who: "owner", text: "I run an AC maintenance company in Sharjah. Four technicians, two dispatchers, about 300 maintenance-contract customers. We quote on WhatsApp and invoice from Excel." },
  {
    who: "renoxium",
    text: "I set up CoolAir from our finished home-services app: your customers and their sites, quotations your customers approve with one tap on WhatsApp, a day board for your dispatchers, the technician’s visit on their phone with photos and the customer’s signature, tax invoices the way the FTA wants them, maintenance contracts that renew themselves, reports, and a back office, in English and Arabic. Your four technicians and two dispatchers have their invitations. It is live at coolair.renoxium.app.",
  },
  { who: "owner", text: "Put it on coolair.ae and give the team @coolair.ae email." },
  {
    who: "renoxium",
    text: "coolair.ae is ready on our side. There is one line to add where you bought the address; I have written it down for you, and the security certificate follows on its own. Six mailboxes at coolair.ae are being set up with our mail partner; I will tell you when they are ready.",
  },
  { who: "owner", text: "Every quotation should carry a 90-day parts warranty line, in Arabic too." },
  { who: "renoxium", text: "Done. The line is on every quotation, on screen and in the PDF, in English and Arabic. I checked it before switching it on. Say the word and I put it back the way it was." },
];

/** Section 3: the request, what happens, and the honest status line, verbatim. `live` marks what works today. */
export const ASKS: readonly { ask: string; text: string; status: string; live: boolean }[] = [
  {
    ask: "“Build me the app for my business.”",
    text: "Your assistant starts from a finished app for your trade (home services first), fills in your company, branches, services and people, and puts it live at <name>.renoxium.app within the hour.",
    status: "Live today when we do it with you on WhatsApp; the ChatGPT and Claude connector is being built (join the list).",
    live: true,
  },
  {
    ask: "“Put it on my web address.”",
    text: "One line to add where you bought the address; we check it is yours and the security certificate is issued and renewed for you.",
    status: "Live today.",
    live: true,
  },
  {
    ask: "“Give my team email at my address.”",
    text: "Mailboxes at your address through a mail partner, arranged in the same conversation.",
    status: "Coming; a date is posted when the partner is signed.",
    live: false,
  },
  {
    ask: "“Change this.”",
    text: "Pages, steps, wording, reports and PDFs change when you ask, in English and Arabic. The parts that must never break (section 5C) do not change this way.",
    status: "Live today through us on WhatsApp; through your own assistant when the connector ships.",
    live: true,
  },
];

/** Section 4: the alternatives, judged fairly. `note` is the plain words after the bold name, if any. */
export const ALTERNATIVES: readonly { name: string; note: string; cost: string; pick: string }[] = [
  { name: "WhatsApp, Excel and paper", note: "", cost: "Hours a day of retyping, lost quotations, late renewals, invoices the tax office can question", pick: "You have one technician and a dozen customers. It is enough." },
  { name: "Rented software", note: "(Zoho, Odoo, Jobber-class tools)", cost: "A fee for every person who uses it, often in dollars; every change is a request to them; Arabic and tax invoices are an afterthought", pick: "You want a known brand and a sales team, and your way of working fits theirs." },
  { name: "An agency builds it", note: "", cost: "AED 50,000 to 100,000 for a first version, then a monthly retainer; every change is billed; the result may not be yours", pick: "You need something nobody has built before, and you can afford to wait." },
  { name: "An AI app builder", note: "(Lovable, Bolt, Base44)", cost: "You pay for every message to their AI; the login, the data and the invoices are improvised too, and they break or leak; nobody to call at 11 pm", pick: "You are trying an idea, not running a business on it." },
];

/** Section 8, verbatim. */
export const NOT_FOR: readonly string[] = [
  "A large company with its own developers who already build on a big web framework: keep them on it.",
  "A business that writes thousands of records a second (a trading desk, a sensor network): you need a heavy database from day one.",
  "A highly interactive app like a design tool or a game: Renoxium is built for business apps, pages and forms.",
  "Health records: we do not host them.",
];

/** A count in the deck's words: 100,000; 2 million; unlimited. */
export function countText(v: number | null): string {
  if (v === null) return "unlimited";
  if (v >= 1_000_000 && v % 1_000_000 === 0) return `${(v / 1_000_000).toLocaleString("en")} million`;
  return v.toLocaleString("en");
}

/** The plan's line of the price table (deck, section 9), with every number read from pricing.toml. */
export function planText(p: PricedPlan): string {
  const q = p.quotas;
  const n = (k: string) => q[k] ?? null;
  const visits = countText(n("requests"));
  const db = quotaText("db_bytes", n("db_bytes"));
  const files = quotaText("storage_bytes", n("storage_bytes"));
  switch (p.id) {
    case "free":
      return `Your app at <name>.renoxium.app: ${countText(n("apps"))} apps, ${visits} visits and actions a month, ${db} of data. Set up with us by hand.`;
    case "starter":
      return `Your own web address (up to ${countText(n("custom_domains"))}), ${countText(n("apps"))} apps, ${visits} visits and actions, ${db} of data, ${files} of files, AI help included.`;
    case "pro":
      return `${countText(n("apps"))} apps, ${countText(n("custom_domains"))} addresses, ${visits} visits and actions, ${db} of data, ${files} of files.`;
    case "agency":
      if (n("apps") !== null || n("requests") !== null) throw new Error("pricing.toml: the Agency line says unlimited apps and visits");
      return `For agencies: unlimited apps and visits, ${countText(n("custom_domains"))} addresses, a workspace per client, your own brand on it.`;
    default:
      throw new Error(`pricing.toml: no line of the copy deck for the plan ${p.id}`);
  }
}

export function load() {
  return {
    links: LINKS,
    waitlistForm: WAITLIST_FORM,
    conversation: CONVERSATION,
    asks: ASKS,
    alternatives: ALTERNATIVES,
    notFor: NOT_FOR,
    stats: STATS.map(({ value, unit, text, link, href }) => ({ value, unit, text, link, href })),
    currency: PRICING.currency,
    plans: PRICING.plans.map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price_month.replace(/\.00$/u, ""),
      recommended: p.id === "starter",
      text: planText(p),
    })),
  };
}
