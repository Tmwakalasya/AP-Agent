import type { DbConnection } from "../../bindings/index.ts";
import type { ReviewInput, Payee } from "../../module/rules.ts";
import type { Timestamp } from "spacetimedb";

const iso = (t: Timestamp) => new Date(Number(t.microsSinceUnixEpoch / 1000n)).toISOString();

// Client-side mirror of the module's projection, built from the subscribed
// cache. Used only so the agent can explain; the reducer recomputes.
export function projectReview(conn: DbConnection, loadId: string, invoiceDocumentId: string): ReviewInput | null {
  const db = conn.db;
  const load = db.load.id.find(loadId); if (!load) return null;
  const carrier = db.carrier.id.find(load.carrierId); if (!carrier) return null;
  const invoiceDoc = db.document.id.find(invoiceDocumentId); if (!invoiceDoc) return null;
  const extraction = [...db.extraction.iter()].find(e => e.documentId === invoiceDocumentId); if (!extraction) return null;
  return {
    as_of: new Date().toISOString(),
    load: { id: load.id, carrier_id: load.carrierId, rate_cents: Number(load.rateCents), delivered: load.delivered, rate_document_id: load.rateDocumentId, pod_document_id: load.podDocumentId ?? null },
    carrier: { id: carrier.id, authority: carrier.authority as "active" | "revoked" },
    invoice: {
      document_id: invoiceDoc.id, carrier_id: invoiceDoc.carrierId, load_id: invoiceDoc.loadId ?? "", invoice_number: extraction.invoiceNumber,
      invoice_at: iso(extraction.invoiceAt), currency: extraction.currency, linehaul_cents: Number(extraction.linehaulCents),
      accessorials_cents: Number(extraction.accessorialsCents), total_cents: Number(extraction.totalCents),
      remit_to: { kind: extraction.remitToKind as Payee["kind"], id: extraction.remitToId }, confidence: extraction.confidence,
    },
    documents: [...db.document.iter()].map(d => ({ id: d.id, kind: d.kind as ReviewInput["documents"][number]["kind"], carrier_id: d.carrierId, load_id: d.loadId ?? null, received_at: iso(d.receivedAt) })),
    assignments: [...db.assignment.iter()].filter(a => a.carrierId === carrier.id).map(a => ({ carrier_id: a.carrierId, factor_id: a.factorId, effective_at: iso(a.effectiveAt), source_document_id: a.sourceDocumentId, released_at: a.releasedAt ? iso(a.releasedAt) : null })),
    reservations: [...db.paymentRequest.iter()].filter(r => r.invoiceDocumentId !== invoiceDocumentId || r.loadId !== loadId)
      .map(r => ({ load_id: r.loadId, carrier_id: r.invoiceKey.split("|")[0], invoice_number: r.invoiceKey.split("|")[1] ?? "" })),
    bank_change_pending: carrier.bankChangePending,
  };
}
