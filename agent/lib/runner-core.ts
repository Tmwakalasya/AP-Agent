import type { DbConnection } from "../../bindings/index.ts";

// The runner's one job: move approved obligations through the provider
// without ever creating a second payment identity for the same obligation.
// Every step persists in the database before the side effect that follows it.

export type RunnerOptions = {
  providerUrl: string;
  crashAfterAccept?: boolean;      // exit(137) after the provider accepts, before recording the outcome
  log?: (line: string) => void;
  timeoutMs?: number;
};
type Req = ReturnType<DbConnection["db"]["paymentRequest"]["iter"]> extends Iterable<infer R> ? R : never;
type ProviderTransfer = { transfer_id: string; status: "accepted" | "settled"; replayed?: boolean };

const money = (c: bigint) => `$${(Number(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
export const keyFor = (r: Req) => `rt-${r.id}-${r.snapshotDigest.slice(0, 8)}`;

export async function runnerPass(conn: DbConnection, opts: RunnerOptions): Promise<boolean> {
  const log = opts.log ?? (() => {});
  const timeout = opts.timeoutMs ?? 5000;
  const db = conn.db;
  const fresh = (id: bigint) => db.paymentRequest.id.find(id)!;
  let progressed = false;

  const http = async (method: string, path: string, body?: string, key?: string) => {
    const res = await fetch(`${opts.providerUrl}${path}`, {
      method, body, signal: AbortSignal.timeout(timeout),
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    });
    return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> & Partial<ProviderTransfer> };
  };

  // Send the frozen payload with the stored key. Called for fresh claims and
  // for reconciliation when the provider has no record of the key.
  const send = async (r: Req) => {
    const key = r.idempotencyKey;
    log(`#${r.id} ${r.loadId}: sending frozen payload with key ${key} · ${money(r.amountCents)} to ${r.payeeKind} ${r.payeeId} bank v${r.bankVersion}`);
    let res: Awaited<ReturnType<typeof http>>;
    try {
      res = await http("POST", "/v1/transfers", r.frozenPayload, key);
    } catch (e) {
      await conn.reducers.recordPaymentOutcome({ requestId: r.id, idempotencyKey: key, outcome: "unknown", transferId: "", detail: `No response from provider (${(e as Error).name}). Obligation stays reserved; will reconcile by key.` });
      log(`#${r.id}: no response from provider → unknown (still reserved, same key on restart)`);
      return;
    }
    if (res.status === 201 || res.status === 200) {
      const id = String(res.json.transfer_id);
      if (opts.crashAfterAccept) {
        log(`#${r.id}: provider accepted ${id}. CRASH: process killed before record_payment_outcome.`);
        process.exit(137);
      }
      await conn.reducers.recordPaymentOutcome({ requestId: r.id, idempotencyKey: key, outcome: "submitted", transferId: id, detail: res.json.replayed ? `Provider replayed existing transfer ${id} for the stored key; nothing was sent twice.` : `Mock provider accepted transfer ${id}. Submitted is not settled.` });
      log(`#${r.id}: ${res.json.replayed ? "replayed" : "accepted"} as ${id} → submitted`);
      progressed = true;
      return;
    }
    await conn.reducers.recordPaymentOutcome({ requestId: r.id, idempotencyKey: key, outcome: "failed", transferId: "", detail: `Provider refused (${res.status}): ${String(res.json.error ?? "")}. Still reserved until a controller reconciles.` });
    log(`#${r.id}: provider refused (${res.status}) → failed (still reserved)`);
    progressed = true;
  };

  // 1. Reconcile anything left mid-flight by a previous process.
  for (const r0 of [...db.paymentRequest.iter()].filter(r => (r.state === "submitting" || r.state === "unknown") && r.idempotencyKey)) {
    const r = fresh(r0.id);
    log(`#${r.id} ${r.loadId}: found ${r.state} with stored key ${r.idempotencyKey}; asking provider before doing anything`);
    try {
      const res = await http("GET", `/v1/transfers/by-key/${encodeURIComponent(r.idempotencyKey)}`);
      if (res.status === 200) {
        const id = String(res.json.transfer_id);
        await conn.reducers.recordPaymentOutcome({ requestId: r.id, idempotencyKey: r.idempotencyKey, outcome: "submitted", transferId: id, detail: `Reconciled after restart: provider holds transfer ${id} for the stored key. Nothing was sent again.` });
        log(`#${r.id}: provider already holds ${id} for that key → submitted. Nothing sent again.`);
        progressed = true;
      } else if (res.status === 404) {
        log(`#${r.id}: provider has no record of the key; the payload never arrived. Sending once with the same key.`);
        await send(r);
      } else {
        log(`#${r.id}: provider lookup returned ${res.status}; leaving ${r.state} for a controller`);
      }
    } catch (e) {
      if (r.state === "submitting") await conn.reducers.recordPaymentOutcome({ requestId: r.id, idempotencyKey: r.idempotencyKey, outcome: "unknown", transferId: "", detail: `Provider unreachable during reconcile (${(e as Error).name}). Reserved; will retry the lookup.` });
      log(`#${r.id}: provider unreachable during reconcile; still reserved, no blind retry`);
    }
  }

  // 2. Claim approved requests. The claim persists the key and payload first.
  for (const r0 of [...db.paymentRequest.iter()].filter(r => r.state === "approved")) {
    const key = keyFor(r0);
    await conn.reducers.claimPayment({ requestId: r0.id, idempotencyKey: key });
    const r = fresh(r0.id);
    if (r.state !== "submitting" || r.idempotencyKey !== key) { log(`#${r.id} ${r.loadId}: claim refused by the database (now ${r.state}); see decision_log`); progressed = true; continue; }
    log(`#${r.id} ${r.loadId}: claimed · key ${key} and payload are now in the database`);
    await send(r);
  }

  // 3. Poll submitted transfers for the mock's simulated settlement.
  for (const r0 of [...db.paymentRequest.iter()].filter(r => r.state === "submitted" && r.transferId)) {
    try {
      const res = await http("GET", `/v1/transfers/${r0.transferId}`);
      if (res.status === 200 && res.json.status === "settled") {
        await conn.reducers.recordPaymentOutcome({ requestId: r0.id, idempotencyKey: r0.idempotencyKey, outcome: "simulated_settled", transferId: r0.transferId, detail: "Mock provider reports settled. Simulated; no funds moved." });
        log(`#${r0.id} ${r0.loadId}: ${r0.transferId} settled at the mock → simulated_settled`);
        progressed = true;
      }
    } catch { /* provider down; poll again next pass */ }
  }
  return progressed;
}
