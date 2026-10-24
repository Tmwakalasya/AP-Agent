// Deterministic snapshot digest shared by the module, the agent and the board.
// FNV-1a 64-bit over a canonical string. Staleness detection only; not a
// security primitive. The module runtime has no synchronous crypto.
export type SnapshotFields = {
  amount_cents: number | null;
  currency: string;
  payee: { kind: string; id: string } | null;
  bank_version: number;
  evidence_ids: string[];
  failed_rules: string[];
};

export function canonicalSnapshot(f: SnapshotFields): string {
  return [
    `amount=${f.amount_cents ?? "null"}`,
    `currency=${f.currency}`,
    `payee=${f.payee ? `${f.payee.kind}:${f.payee.id}` : "null"}`,
    `bank=${f.bank_version}`,
    `evidence=${[...f.evidence_ids].sort().join(",")}`,
    `failed=${[...f.failed_rules].sort().join(",")}`,
  ].join("|");
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
