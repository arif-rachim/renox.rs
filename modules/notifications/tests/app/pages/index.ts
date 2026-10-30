import { notifications } from "renox:modules";

export async function load() {
  return { notif_badge: await notifications.badge() };
}
