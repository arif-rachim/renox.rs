// The audit trail's retention as a scheduled job (#297; ops.md section 20):
// every night at 02:30 UTC, rows older than retain_days (never fewer than
// 30 days) are deleted. It runs as Renox::System::"audit".
import { prune } from "../services.ts";

export const schedule = "30 2 * * *";

export async function run(ctx: Parameters<typeof prune>[0]): Promise<void> {
  await prune(ctx);
}
