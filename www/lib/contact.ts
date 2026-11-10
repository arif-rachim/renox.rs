// How the site reaches people (#675): the platform's mail and WhatsApp, the
// dashboard's sign-in, and the public places the proof section points at. One
// place, so no page hard-codes an address. The site has no secrets and no
// environment of its own (renox.toml), so these are constants; a change of
// number or address is a change here and a deploy.

/** The platform's contact address (`docs/contracts/README.md`, "Domains"). */
export const CONTACT_EMAIL = "support@renoxium.com";

/**
 * The platform's WhatsApp number in international form, digits only, or
 * `null` while the owner has not given one. While it is `null`, the WhatsApp
 * buttons open a mail to `CONTACT_EMAIL` with the subject "WhatsApp setup", so
 * no button points at a number nobody answers.
 */
export const WHATSAPP_NUMBER: string | null = null;

/** The dashboard's origin (`control/api` `CONTROL_DASHBOARD_URL`). */
export const DASHBOARD_ORIGIN = "https://dashboard.renoxium.com";

/** The public repository: the code, the measurements, the open problems. */
export const REPOSITORY = "https://github.com/arif-rachim/renox.rs";

const mailto = (subject: string): string => `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;

/** A WhatsApp chat link (`https://wa.me/<digits>`), or the mail fallback while there is no number. */
export function whatsappLink(number: string | null = WHATSAPP_NUMBER): string {
  if (number === null) return mailto("WhatsApp setup");
  const digits = number.replace(/\D/gu, "");
  if (!/^\d{8,15}$/u.test(digits)) throw new Error(`WHATSAPP_NUMBER is not an international number: ${number}`);
  return `https://wa.me/${digits}`;
}

export const LINKS = {
  signIn: `${DASHBOARD_ORIGIN}/signin`,
  connectorList: mailto("Connector list"),
  whatsapp: whatsappLink(),
  code: REPOSITORY,
  benchmarks: `${REPOSITORY}/blob/main/docs/14-benchmarks.md`,
  status: `${REPOSITORY}#status`,
  takeAway: `${REPOSITORY}/issues/668`,
} as const;
