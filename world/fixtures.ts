import type { ReviewInput } from "../module/rules.ts";

// Synthetic extracted records only. No PDFs, model calls, hidden answer key,
// database connection or payment provider is supplied to the policy core.
export type Case = { id: string; input: ReviewInput };

export function cleanCase(index = 1): Case {
  const suffix = String(index).padStart(3, "0");
  const loadId = `L-${suffix}`;
  const carrierId = `C-${suffix}`;
  return {
    id: `clean-${suffix}`,
    input: {
      as_of: "2026-06-10T12:00:00Z",
      load: {
        id: loadId, carrier_id: carrierId, rate_cents: 240_000, delivered: true,
        rate_document_id: `D-rate-${suffix}`, pod_document_id: `D-pod-${suffix}`,
      },
      carrier: { id: carrierId, authority: "active" },
      invoice: {
        document_id: `D-invoice-${suffix}`, carrier_id: carrierId, load_id: loadId,
        invoice_number: `INV-${suffix}`, invoice_at: "2026-06-10T09:00:00Z",
        currency: "USD", linehaul_cents: 240_000, accessorials_cents: 0, total_cents: 240_000,
        remit_to: { kind: "carrier", id: carrierId }, confidence: 0.99,
      },
      documents: [
        { id: `D-rate-${suffix}`, kind: "rate_con", carrier_id: carrierId, load_id: loadId, received_at: "2026-06-01T09:00:00Z" },
        { id: `D-pod-${suffix}`, kind: "pod", carrier_id: carrierId, load_id: loadId, received_at: "2026-06-09T18:00:00Z" },
        { id: `D-invoice-${suffix}`, kind: "invoice", carrier_id: carrierId, load_id: loadId, received_at: "2026-06-10T10:00:00Z" },
      ],
      assignments: [], reservations: [], bank_change_pending: false,
    },
  };
}

export function duplicateCase(index = 25): Case {
  const scenario = cleanCase(index);
  scenario.id = `duplicate-${String(index).padStart(3, "0")}`;
  scenario.input.reservations.push({
    load_id: scenario.input.load.id, carrier_id: scenario.input.carrier.id,
    invoice_number: `ORIGINAL-${index}`,
  });
  // Rebilling under a new invoice number must still be caught by load identity.
  scenario.input.invoice.invoice_number = `REISSUED-${index}`;
  return scenario;
}

export function redirectCase(index = 31): Case {
  const scenario = cleanCase(index);
  scenario.id = `redirect-${String(index).padStart(3, "0")}`;
  const { input } = scenario;
  input.documents.push({
    id: `D-noa-${index}`, kind: "noa", carrier_id: input.carrier.id,
    load_id: null, received_at: "2026-03-02T09:00:00Z",
  });
  input.assignments.push({
    carrier_id: input.carrier.id, factor_id: "F-01", effective_at: "2026-03-02T09:00:00Z",
    source_document_id: `D-noa-${index}`, released_at: null,
  });
  // The June invoice requests carrier payment despite the verified March NOA.
  // The later live demo will extract the same request from an email attachment.
  return scenario;
}

export function developmentCases(): Case[] {
  return [
    ...Array.from({ length: 24 }, (_, i) => cleanCase(i + 1)),
    ...Array.from({ length: 6 }, (_, i) => duplicateCase(i + 25)),
    ...Array.from({ length: 6 }, (_, i) => redirectCase(i + 31)),
  ];
}
