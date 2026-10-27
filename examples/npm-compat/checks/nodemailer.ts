// Official package (nodemailer). Sends one message into a stream transport
// (no network) and checks the generated MIME.
import nodemailer from "nodemailer";
import { assert } from "./_lib/assert.ts";

export async function check(): Promise<void> {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  const info = await transport.sendMail({
    from: "noreply@example.com",
    to: "customer@example.com",
    subject: "Order confirmation",
    text: "شكراً لطلبك",
  });
  const mime = (info.message as Buffer).toString("utf8");
  assert(mime.includes("Subject: Order confirmation"), "subject header present");
  assert(mime.includes("To: customer@example.com"), "to header present");
}
