import type { DbConnection } from "../../bindings/index.ts";
import type { Timestamp } from "spacetimedb";

type Row<T extends keyof DbConnection["db"]> = NonNullable<ReturnType<DbConnection["db"][T]["iter"]>> extends Iterable<infer R> ? R : never;
export type Load = Row<"load">;
export type Carrier = Row<"carrier">;
export type Doc = Row<"document">;
export type Settlement = Row<"settlement">;
export type PaymentRequest = Row<"paymentRequest">;
export type LogRow = Row<"decisionLog">;

export type Status =
  | "awaiting_agent" | "hold" | "ready" | "pending" | "approved" | "rejected"
  | "submitting" | "submitted" | "unknown" | "failed" | "simulated_settled";

export type Item = {
  key: string;
  loadId: string;
  invoiceDocId: string | null;
  load: Load;
  carrier: Carrier | undefined;
  invoiceDoc: Doc | undefined;
  settlement: Settlement | undefined;
  request: PaymentRequest | undefined;
  status: Status;
  rebill: boolean;
};

export const money = (cents: bigint | number) => {
  const n = Number(cents);
  return `$${(n / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
export const toDate = (ts: Timestamp) => new Date(Number(ts.microsSinceUnixEpoch / 1000n));
export const shortDate = (ts: Timestamp) => toDate(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const clock = (ts: Timestamp) => toDate(ts).toLocaleTimeString("en-US", { hour12: false });

export const STATUS_LABEL: Record<Status, string> = {
  awaiting_agent: "awaiting agent", hold: "■ hold", ready: "ready", pending: "pending approval",
  approved: "□ approved", rejected: "rejected", submitting: "submitting", submitted: "submitted",
  unknown: "unknown", failed: "failed", simulated_settled: "simulated settled",
};

export function items(conn: DbConnection): Item[] {
  const db = conn.db;
  const loads = [...db.load.iter()].sort((a, b) => (a.id < b.id ? 1 : -1));
  const settlements = [...db.settlement.iter()];
  const requests = [...db.paymentRequest.iter()];
  const out: Item[] = [];
  for (const load of loads) {
    const carrier = db.carrier.id.find(load.carrierId) ?? undefined;
    // Latest settlement per invoice document; the first (oldest) invoice is the
    // primary line for the load, any later invoice is shown as a re-bill.
    const byDoc = new Map<string, Settlement>();
    for (const s of settlements.filter(s => s.loadId === load.id).sort((a, b) => Number(a.id - b.id))) byDoc.set(s.invoiceDocumentId, s);
    const invoiceDocs = [...db.document.iter()].filter(d => d.loadId === load.id && d.kind === "invoice")
      .sort((a, b) => Number(a.receivedAt.microsSinceUnixEpoch - b.receivedAt.microsSinceUnixEpoch));
    if (invoiceDocs.length === 0) {
      out.push({ key: load.id, loadId: load.id, invoiceDocId: null, load, carrier, invoiceDoc: undefined, settlement: undefined, request: undefined, status: "awaiting_agent", rebill: false });
      continue;
    }
    invoiceDocs.forEach((doc, i) => {
      const settlement = byDoc.get(doc.id);
      const request = requests.find(r => r.loadId === load.id && r.invoiceDocumentId === doc.id);
      const status: Status = request ? (request.state as Status) : !settlement ? "awaiting_agent" : settlement.decision === "hold" ? "hold" : "ready";
      out.push({ key: `${load.id}:${doc.id}`, loadId: load.id, invoiceDocId: doc.id, load, carrier, invoiceDoc: doc, settlement, request, status, rebill: i > 0 });
    });
  }
  return out;
}

export function documentsFor(conn: DbConnection, item: Item): Doc[] {
  const docs = [...conn.db.document.iter()];
  const forLoad = docs.filter(d => d.loadId === item.loadId);
  const carrierWide = docs.filter(d => d.carrierId === item.load.carrierId && !d.loadId);
  const order = ["invoice", "email", "noa", "rate_con", "pod"];
  return [...forLoad, ...carrierWide]
    .filter(d => d.kind !== "invoice" || d.id === item.invoiceDocId)
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export function auditFor(conn: DbConnection, loadId?: string, limit = 14): LogRow[] {
  return [...conn.db.decisionLog.iter()]
    .filter(l => !loadId || l.loadId === loadId)
    .sort((a, b) => Number(b.id - a.id))
    .slice(0, limit);
}

export function lastActionBy(conn: DbConnection, identityHex: string, requestId?: bigint, loadId?: string): LogRow | undefined {
  return [...conn.db.decisionLog.iter()]
    .filter(l => l.actorIdentity.toHexString() === identityHex)
    .filter(l => (requestId !== undefined && l.requestId === requestId) || (loadId !== undefined && l.loadId === loadId))
    .filter(l => !["bootstrap_persona"].includes(l.operation))
    .sort((a, b) => Number(b.id - a.id))[0];
}
