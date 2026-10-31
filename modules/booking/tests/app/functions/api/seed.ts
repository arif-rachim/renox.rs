// Test only: a service and a staff member open every day (app code with booking.manage).
// `?hours=540-600` opens 09:00 to 10:00 only, and adds a service with a
// deposit of AED 25.05 (the RTL snapshots, #336: a short, stable page).
import { booking } from "renox:modules";

export async function POST(ctx) {
  const staffUser = ctx.url.searchParams.get("staff_user");
  const [open, close] = (ctx.url.searchParams.get("hours") ?? "0-1440").split("-").map(Number);
  await booking.addService({ id: "cut", name: "Haircut", minutes: 30, buffer: 0 });
  const services = ["cut"];
  if (ctx.url.searchParams.has("hours")) {
    await booking.addService({ id: "color", name: "Colour", minutes: 60, buffer: 0, deposit_fils: 2505 });
    services.push("color");
  }
  await booking.addStaff({ id: "sara", name: "Sara", user_id: staffUser, services });
  for (let d = 0; d < 7; d++) await booking.setHours("sara", d, open, close);
  return Response.json({ ok: true });
}
