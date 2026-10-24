import type { ReviewInput } from './rules.ts';

// Deterministic approval snapshot digest used by the module.
// FNV-1a 64-bit over a canonical string. Staleness detection only; not a
// security primitive. The module runtime has no synchronous crypto.
export type SnapshotFields = {
  amount_cents: number | null;
  currency: string;
  payee: { kind: string; id: string } | null;
  bank_version: number;
  evidence_ids: string[];
  failed_rules: string[];
  invoice: ReviewInput['invoice'];
};

export function canonicalSnapshot(f: SnapshotFields): string {
  const i = f.invoice;
  // Explicit field order and JSON escaping keep invoice text unambiguous.
  // Bind the facts that policy read, even when a correction leaves its verdict
  // and agreed payment amount unchanged. Display-only prose is excluded.
  return JSON.stringify([
    2, f.amount_cents, f.currency, f.payee ? [f.payee.kind, f.payee.id] : null,
    f.bank_version, [...f.evidence_ids].sort(), [...f.failed_rules].sort(),
    [i.document_id, i.carrier_id, i.load_id, i.invoice_number, i.invoice_at,
      i.currency, i.linehaul_cents, i.accessorials_cents, i.total_cents,
      i.remit_to.kind, i.remit_to.id, i.confidence],
  ]);
}

export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export function snapshotDigest(f: SnapshotFields): string {
  return fnv1a64(canonicalSnapshot(f));
}
