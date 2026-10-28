// Publishes committed route changes to the connected nodes. After every
// commit that changed routes, the writer calls publish(): it NOTIFYs the other
// API instances (channel renox_routes) and pumps the local hub. Each pump
// sends one delta with every change since the last one it sent.

import type { Db } from "../db/db.ts";
import type { Hub } from "../workers/hub.ts";
import { currentVersion, deltaSince } from "./table.ts";

export const ROUTES_CHANNEL = "renox_routes";

export class Publisher {
  private last: number | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly hub: Hub,
  ) {}

  /**
   * Starts the delta sequence at `version` if nothing was sent yet. A node
   * that connects gets `resync` and fetches a snapshot, so changes before the
   * first delta are never lost.
   */
  anchor(version: number): void {
    this.last ??= version;
  }

  /** Sends the pending changes; calls are serialised. */
  pump(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.last === null) {
        this.last = await currentVersion(this.db);
        return;
      }
      const delta = await deltaSince(this.db, this.last);
      if (delta === null) return;
      this.last = delta.version;
      this.hub.broadcast(delta);
    }).catch(() => {
      // A failed read is retried by the next pump; nodes also resync periodically.
    });
    return this.queue;
  }

  /** After a commit that changed routes. */
  async publish(): Promise<void> {
    await this.pump();
    await this.db.query("select pg_notify($1, $2)", [ROUTES_CHANNEL, String(this.last ?? 0)]).catch(() => {});
  }

  /** Follows the other instances' changes. */
  async listen(): Promise<() => Promise<void>> {
    this.anchor(await currentVersion(this.db));
    return this.db.listen(ROUTES_CHANNEL, () => void this.pump());
  }
}
