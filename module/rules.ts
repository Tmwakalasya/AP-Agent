// Offline policy core. Reducers must load trusted records and enforce these
// checks again in the same transaction that reserves a payment obligation.
// This file neither authenticates callers nor moves or persists money.
export type Payee = { kind: "carrier" | "factor"; id: string };
export type RuleId = "R1" | "R2" | "R3" | "R6" | "R7" | "R8" | "R9" | "R10";
export type Document = {
  id: string;
  kind: "invoice" | "rate_con" | "pod" | "noa" | "email";
  carrier_id: string;
  load_id: string | null;
  received_at: string;
};
export type ReviewInput = {
  as_of: string;
  load: {
    id: string;
    carrier_id: string;
    rate_cents: number;
    delivered: boolean;
    rate_document_id: string;
    pod_document_id: string | null;
  };
  carrier: { id: string; authority: "active" | "revoked" };
  invoice: {
    document_id: string;
    carrier_id: string;
    load_id: string;
    invoice_number: string;
    invoice_at: string;
    currency: string;
    linehaul_cents: number;
    accessorials_cents: number;
    total_cents: number;
    remit_to: Payee;
    confidence: number;
  };
  documents: Document[];
  assignments: {
    carrier_id: string;
    factor_id: string;
    effective_at: string;
    source_document_id: string;
    released_at: string | null;
  }[];
  // Includes pending, in-flight, uncertain and paid obligations. Payee is
  // deliberately absent: changing payee must not permit another payment.
  reservations: { load_id: string; carrier_id: string; invoice_number: string }[];
  bank_change_pending: boolean;
};
export type RuleResult = { rule_id: RuleId; passed: boolean; reason: string };
export type Decision = {
  decision: "request_approval" | "hold";
  amount_cents: number | null;
  payee: Payee | null;
  rule_results: RuleResult[];
  evidence_ids: string[];
  question: string | null;
};

// Human labels for the rules. R10 covers several field checks under one id.
export const RULE_LABELS: Record<RuleId, string> = {
  R1: "Amount matches rate confirmation",
  R2: "Payee matches verified assignment",
  R3: "No existing obligation for this load",
  R6: "Delivered, POD on file",
  R7: "Invoice, load and carrier agree",
  R8: "No unresolved bank change",
  R9: "Carrier authority active",
  R10: "Documents and fields valid",
};

export const AP_LIMIT_CENTS = 500_000;
export const RATE_TOLERANCE_CENTS = 100;
export const MIN_EXTRACTION_CONFIDENCE = 0.95;

export function normalizeInvoiceNumber(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function timestamp(value: string): number {
  // Reject dates that Date.parse would silently normalize, e.g. February 30.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  const canonical = value.includes(".") ? value : value.replace("Z", ".000Z");
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === canonical ? parsed : NaN;
}

function cents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function evaluateSettlement(input: ReviewInput): Decision {
  const { load, carrier, invoice, documents, assignments, reservations } = input;
  const rule_results: RuleResult[] = [];
  const evidence = new Set<string>();
  const check = (rule_id: RuleId, passed: boolean, reason: string) => {
    rule_results.push({ rule_id, passed, reason });
  };
  const now = timestamp(input.as_of);
  const invoiceAt = timestamp(invoice.invoice_at);
  const documentFor = (id: string | null, kind: Document["kind"], loadId: string | null) => {
    const found = documents.filter(d => d.id === id);
    if (found.length !== 1) return undefined;
    const doc = found[0];
    if (doc.kind !== kind || doc.carrier_id !== carrier.id || doc.load_id !== loadId ||
        !(timestamp(doc.received_at) <= now)) return undefined;
    evidence.add(doc.id);
    return doc;
  };

  check("R10", Number.isFinite(now) && Number.isFinite(invoiceAt) && invoiceAt <= now,
    "Review time and invoice date must be valid UTC timestamps; future invoices are held.");
  check("R10", cents(load.rate_cents) && load.rate_cents > 0 && cents(invoice.linehaul_cents) &&
    cents(invoice.accessorials_cents) && cents(invoice.total_cents) &&
    invoice.linehaul_cents + invoice.accessorials_cents === invoice.total_cents,
    "Amounts must be nonnegative safe integer cents and invoice lines must sum to the total.");
  check("R10", invoice.currency === "USD" && invoice.accessorials_cents === 0,
    "The first slice supports USD linehaul only; other currencies and accessorials need review.");
  check("R10", Number.isFinite(invoice.confidence) && invoice.confidence >= MIN_EXTRACTION_CONFIDENCE && invoice.confidence <= 1,
    "Low extraction confidence requires review; high confidence never bypasses other checks.");
  check("R10", typeof invoice.invoice_number === "string" && normalizeInvoiceNumber(invoice.invoice_number).length > 0,
    "An invoice number is required.");
  check("R7", carrier.id === load.carrier_id && invoice.carrier_id === carrier.id && invoice.load_id === load.id,
    "Invoice, load and carrier identifiers must agree.");
  check("R10", Boolean(documentFor(invoice.document_id, "invoice", load.id)) &&
    Boolean(documentFor(load.rate_document_id, "rate_con", load.id)),
    "Invoice and rate confirmation must be known documents for this carrier and load.");
  check("R6", load.delivered && Boolean(documentFor(load.pod_document_id, "pod", load.id)),
    "Delivery and a POD for this carrier and load are required.");
  check("R9", carrier.authority === "active", "The seeded carrier authority must be active.");
  check("R8", input.bank_change_pending === false, "Unresolved bank changes require controller review.");
  check("R1", cents(load.rate_cents) && cents(invoice.linehaul_cents) &&
    Math.abs(invoice.linehaul_cents - load.rate_cents) <= RATE_TOLERANCE_CENTS,
    "Linehaul must match the agreed rate within 100 cents; the proposed payment uses the agreed rate.");
  const duplicate = reservations.some(r => r.load_id === load.id ||
    (r.carrier_id === carrier.id && typeof invoice.invoice_number === "string" &&
      normalizeInvoiceNumber(r.invoice_number) === normalizeInvoiceNumber(invoice.invoice_number)));
  check("R3", !duplicate, "An existing obligation reserves the load and carrier/invoice number, regardless of payee.");

  let assignmentDataValid = true;
  const effective = assignments.filter(a => {
    if (a.carrier_id !== carrier.id) return false;
    const effectiveAt = timestamp(a.effective_at);
    if (!Number.isFinite(effectiveAt)) assignmentDataValid = false;
    // Release scope is deliberately unsupported until domain policy is agreed.
    if (effectiveAt <= invoiceAt && (a.released_at !== null || !a.factor_id ||
        !documentFor(a.source_document_id, "noa", null))) assignmentDataValid = false;
    return effectiveAt <= invoiceAt;
  });
  const payee: Payee | null = !assignmentDataValid || effective.length > 1 ? null :
    effective.length === 1 ? { kind: "factor", id: effective[0].factor_id } : { kind: "carrier", id: carrier.id };
  check("R2", payee !== null && invoice.remit_to?.kind === payee.kind && invoice.remit_to?.id === payee.id,
    payee === null ? "Conflicting or released assignments require controller review." :
      `The verified assignment policy requires ${payee.kind} ${payee.id}; invoice or email instructions cannot change it.`);

  const failed = rule_results.filter(r => !r.passed);
  return {
    decision: failed.length ? "hold" : "request_approval",
    amount_cents: cents(load.rate_cents) && load.rate_cents > 0 ? load.rate_cents : null,
    payee,
    rule_results,
    evidence_ids: [...evidence],
    question: failed.length === 0 ? null : failed.some(r => r.rule_id === "R3") ?
      "AP lead: reconcile this invoice with the existing obligation; do not create another payment." :
      failed.some(r => r.rule_id === "R2") && payee?.kind === "factor" ?
        `Factor ${payee.id}: confirm the assignment and provide release evidence if applicable; keep the payment held.` :
        "Controller: review the failed rules and evidence before requesting a new decision.",
  };
}

export type ApprovalInput = {
  actor: { id: string; role: "agent" | "ap_lead" | "controller"; approval_limit_cents: number };
  request: { requested_by: string; amount_cents: number; status: string; snapshot_current: boolean };
};

// Reducers must derive the actor from ctx.sender and snapshot_current from
// trusted state. These values must never come directly from a client.
export function checkApproval({ actor, request }: ApprovalInput): { allowed: boolean; reason: string } {
  if (actor.role !== "ap_lead" && actor.role !== "controller") return { allowed: false, reason: "Role cannot approve payments." };
  if (actor.id === request.requested_by) return { allowed: false, reason: "The requester cannot approve their own request." };
  if (request.status !== "pending") return { allowed: false, reason: "Only pending requests can be approved." };
  if (!request.snapshot_current) return { allowed: false, reason: "The approved amount, payee or evidence snapshot is stale." };
  if (!cents(request.amount_cents) || request.amount_cents === 0) return { allowed: false, reason: "A positive safe integer amount is required." };
  if (!cents(actor.approval_limit_cents) || request.amount_cents > actor.approval_limit_cents ||
      (actor.role === "ap_lead" && request.amount_cents > AP_LIMIT_CENTS)) {
    return { allowed: false, reason: "Amount exceeds the approver's limit." };
  }
  return { allowed: true, reason: "A different authorized actor may approve this unchanged request." };
}
