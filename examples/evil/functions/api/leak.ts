// GET /api/leak: tries to write the declared secret FAKE_SECRET to the logs.
// Redaction (ops.md section 3) must replace every occurrence with
// "[redacted]" before the line reaches the tenant log sink. The handler cannot
// see the sink, so it only reports what it attempted; the test reads the sink.
// The response never contains the secret.
import type { Handler } from "renox";

export const GET: Handler = ({ secrets, log }) => {
  const value = secrets["FAKE_SECRET"];
  if (value === undefined) return Response.json({ present: false, attempts: 0 });
  console.log(value);
  console.log(`key=${value}`);
  log.info("leak attempt", { secret: value });
  console.error(new Error(`failed with ${value}`));
  return Response.json({ present: true, attempts: 4 });
};
