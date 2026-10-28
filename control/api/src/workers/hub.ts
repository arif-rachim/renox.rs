// Delivery of control messages to the nodes connected to this API instance.
// Route deltas go to every node; prepare goes to one (deploy-api.md section 7).

export type Send = (message: unknown) => void;

export class Hub {
  private readonly streams = new Map<string, Set<Send>>();

  /** Registers a node's stream; returns the function that removes it. */
  subscribe(nodeId: string, send: Send): () => void {
    let set = this.streams.get(nodeId);
    if (set === undefined) {
      set = new Set();
      this.streams.set(nodeId, set);
    }
    set.add(send);
    return () => {
      set.delete(send);
      if (set.size === 0) this.streams.delete(nodeId);
    };
  }

  broadcast(message: unknown): void {
    for (const set of this.streams.values()) for (const send of set) send(message);
  }

  /** Sends to one node's streams; false when the node is not connected here. */
  sendTo(nodeId: string, message: unknown): boolean {
    const set = this.streams.get(nodeId);
    if (set === undefined) return false;
    for (const send of set) send(message);
    return true;
  }

  connected(): string[] {
    return [...this.streams.keys()];
  }
}
