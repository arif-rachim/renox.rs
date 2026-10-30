// Test only: a service and a staff member open every day (app code with booking.manage).
import { booking } from "renox:modules";

export async function POST(ctx) {
  const staffUser = ctx.url.searchParams.get("staff_user");
  await booking.addService({ id: "cut", name: "Haircut", minutes: 30, buffer: 0 });
  await booking.addStaff({ id: "sara", name: "Sara", user_id: staffUser, services: ["cut"] });
  for (let d = 0; d < 7; d++) await booking.setHours("sara", d, 0, 1440);
  return Response.json({ ok: true });
}
