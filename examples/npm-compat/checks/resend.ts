// Official SDK (resend). Constructs the client and an email object; no request is sent.
import { Resend, type CreateEmailOptions } from "resend";
import { assert, assertEqual } from "./_lib/assert.ts";

export async function check(): Promise<void> {
  const resend = new Resend("re_renox_fake_not_a_secret");
  assert(typeof resend.emails.send === "function", "emails.send exists");
  const email: CreateEmailOptions = {
    from: "Renox <noreply@example.com>",
    to: ["customer@example.com"],
    subject: "تأكيد الطلب / Order confirmation",
    html: "<p dir=\"rtl\">شكراً لطلبك</p>",
  };
  assertEqual(Array.isArray(email.to), true, "to is a list");
}
