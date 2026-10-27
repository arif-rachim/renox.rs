// Official package (date-fns). Adds days across a month boundary and formats.
import { addDays, format } from "date-fns";
import { assertEqual } from "./_lib/assert.ts";

export async function check(): Promise<void> {
  const d = addDays(new Date(2026, 0, 30), 3);
  assertEqual(format(d, "yyyy-MM-dd"), "2026-02-02", "addDays + format");
  assertEqual(format(new Date(2028, 1, 28), "EEEE"), "Monday", "weekday name");
}
