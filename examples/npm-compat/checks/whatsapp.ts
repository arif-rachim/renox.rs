// Hand-written request builder for the WhatsApp Cloud API (no official
// JavaScript SDK; the API is plain JSON over HTTPS). Builds a template message
// request and validates its shape; nothing is sent and nothing is signed.
import { assert, assertEqual } from "./_lib/assert.ts";

const GRAPH_VERSION = "v21.0";

export interface TemplateMessage {
  to: string;
  template: string;
  language: string;
  bodyParams: string[];
}

export function buildTemplateMessage(phoneNumberId: string, token: string, m: TemplateMessage): Request {
  if (!/^\d{8,15}$/.test(m.to)) throw new Error("recipient must be E.164 digits without '+'");
  return new Request(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: m.to,
      type: "template",
      template: {
        name: m.template,
        language: { code: m.language },
        components: [{ type: "body", parameters: m.bodyParams.map((text) => ({ type: "text", text })) }],
      },
    }),
  });
}

export async function check(): Promise<void> {
  const req = buildTemplateMessage("1234567890", "renox-fake-token", {
    to: "971500000001",
    template: "order_confirmation",
    language: "ar",
    bodyParams: ["أحمد", "AED 99.50"],
  });
  assertEqual(new URL(req.url).pathname, `/${GRAPH_VERSION}/1234567890/messages`, "endpoint");
  const body = (await req.json()) as {
    messaging_product: string;
    template: { language: { code: string }; components: { parameters: { text: string }[] }[] };
  };
  assertEqual(body.messaging_product, "whatsapp", "messaging_product");
  assertEqual(body.template.language.code, "ar", "language");
  assertEqual(body.template.components[0]?.parameters[0]?.text, "أحمد", "Arabic parameter survives JSON");
  let rejected = false;
  try {
    buildTemplateMessage("1", "t", { to: "+97150", template: "x", language: "en", bodyParams: [] });
  } catch {
    rejected = true;
  }
  assert(rejected, "invalid recipient rejected");
}
