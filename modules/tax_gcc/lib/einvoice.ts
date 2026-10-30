// E-invoicing (#331): the interface an accredited provider (an ASP for the
// UAE's e-invoicing programme) implements. No live provider is wired: the
// UAE programme's accredited providers are an owner choice (docs/21
// section 10, a verify item), so the module ships the interface and a
// recording fake that tests and staging use.

export interface EInvoiceDocument {
  number: string;
  kind: "invoice" | "credit_note";
  issued_at: number;
  seller_trn: string;
  buyer_trn: string | null;
  total_fils: number;
  vat_fils: number;
}

export interface EInvoiceProvider {
  readonly name: string;
  submit(doc: EInvoiceDocument): Promise<{ id: string; status: "submitted" | "accepted" | "rejected" }>;
  status(id: string): Promise<"submitted" | "accepted" | "rejected" | "cancelled">;
  cancel(id: string): Promise<void>;
}

/** A provider that records what it was given and accepts it; `reject` makes the next submission rejected. */
export function recordingProvider(): EInvoiceProvider & { submitted: EInvoiceDocument[]; reject: boolean } {
  const states = new Map<string, "submitted" | "accepted" | "rejected" | "cancelled">();
  const p = {
    name: "recording",
    submitted: [] as EInvoiceDocument[],
    reject: false,
    async submit(doc: EInvoiceDocument) {
      p.submitted.push(doc);
      const id = `rec_${p.submitted.length}`;
      const status = p.reject ? ("rejected" as const) : ("accepted" as const);
      p.reject = false;
      states.set(id, status);
      return { id, status };
    },
    async status(id: string) {
      return states.get(id) ?? "rejected";
    },
    async cancel(id: string) {
      states.set(id, "cancelled");
    },
  };
  return p;
}
