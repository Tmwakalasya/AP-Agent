import type { DbConnection } from "../../bindings/index.ts";
import type { Decision } from "../../module/rules.ts";

// Deterministic prose used when Claude is unavailable. It only restates the
// structured decision; it cannot change it.
export function explainDecision(conn: DbConnection, loadId: string, invoiceDocumentId: string, d: Decision): { explanation: string; escalationEmail: string } {
  const db = conn.db;
  const load = db.load.id.find(loadId)!;
  const carrier = db.carrier.id.find(load.carrierId)!;
  const factor = d.payee?.kind === "factor" ? db.factor.id.find(d.payee.id) : undefined;
  const failed = d.rule_results.filter(r => !r.passed);
  const money = (c: number | null) => c === null ? "—" : `$${(c / 100).toFixed(2)}`;
  if (failed.length === 0) {
    return {
      explanation: `[template] ${carrier.name}'s invoice for ${loadId} matches the rate confirmation at ${money(d.amount_cents)}, the load is delivered with a POD on file, and no other obligation reserves this load. Policy payee is ${d.payee?.kind} ${d.payee?.id}. Requesting approval from a different human.`,
      escalationEmail: "",
    };
  }
  const ids = failed.map(r => r.rule_id).join(", ");
  const explanation = failed.some(r => r.rule_id === "R2") && factor
    ? `[template] The invoice asks us to pay ${carrier.name} directly. A verified notice of assignment routes ${carrier.name}'s receivables to ${factor.name}, and nothing on file releases it. Any later instruction to change remittance is unverified and cannot replace a verified payment instruction. Held (${ids}).`
    : failed.some(r => r.rule_id === "R3")
      ? `[template] An obligation for ${loadId} already exists. This invoice carries a different number but bills the same load, so it is a duplicate until an AP lead reconciles it. Held (${ids}).`
      : `[template] Policy held this invoice: ${ids}. ${failed.map(r => r.reason).join(" ")}`;
  const escalationEmail = factor && failed.some(r => r.rule_id === "R2")
    ? `To: ${factor.contactEmail}\nSubject: Confirm assignment status for ${carrier.name} (${loadId})\n\nHello ${factor.name} team,\n\nWe received an invoice from ${carrier.name} for load ${loadId} (${money(d.amount_cents)}) that directs payment to the carrier. Our records show a verified notice of assignment in your favor effective March 2, 2026, with no release on file.\n\nPlease confirm whether the assignment remains in force. We are holding payment until we hear from you.\n\nRemit-To, on behalf of accounts payable`
    : failed.some(r => r.rule_id === "R3")
      ? `To: ap-lead\nSubject: Duplicate billing on ${loadId}\n\nA second invoice for ${loadId} arrived under a new number. An obligation already reserves this load. Please reconcile; no new payment was created.`
      : `To: controller\nSubject: Review ${loadId}\n\nRules ${ids} failed. Evidence: ${d.evidence_ids.join(", ")}.`;
  return { explanation, escalationEmail };
}
