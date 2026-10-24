import { t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { Timestamp } from 'spacetimedb';
import spacetimedb, { RuleResult } from './schema.ts';
import { evaluateSettlement, checkApproval, normalizeInvoiceNumber } from '../rules.ts';
import type { Decision, Payee, ReviewInput } from '../rules.ts';
import { snapshotDigest } from '../digest.ts';

export { default } from './schema.ts';

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type Actor = NonNullable<ReturnType<Ctx['db']['actor']['id']['find']>>;
type Role = 'agent' | 'ap_lead' | 'controller' | 'runner' | 'world';
type Request = NonNullable<ReturnType<Ctx['db']['paymentRequest']['id']['find']>>;

// ---------------------------------------------------------------- helpers

function ts(iso: string): Timestamp {
  return new Timestamp(BigInt(Date.parse(iso)) * 1000n);
}
function iso(stamp: Timestamp): string {
  return new Date(Number(stamp.microsSinceUnixEpoch / 1000n)).toISOString();
}
// Unsafe magnitudes deliberately become unsafe numbers so rules.ts fails R10.
function cents(value: bigint): number {
  return Number(value);
}

function actorFor(ctx: Ctx): Actor | null {
  for (const row of ctx.db.actor.iter()) {
    if (row.identity && row.identity.isEqual(ctx.sender)) return row;
  }
  return null;
}

type LogInput = {
  actor: Actor | null; operation: string; outcome: 'ok' | 'refused' | 'reserved' | 'held';
  reason: string; ruleResults?: Decision['rule_results']; evidenceIds?: string[];
  loadId?: string; requestId?: bigint;
};
function log(ctx: Ctx, input: LogInput) {
  ctx.db.decisionLog.insert({
    id: 0n,
    actorId: input.actor?.id ?? 'unbound',
    actorIdentity: ctx.sender,
    operation: input.operation,
    outcome: input.outcome,
    reason: input.reason,
    ruleResults: (input.ruleResults ?? []).map(r => ({ ruleId: r.rule_id, passed: r.passed, reason: r.reason })),
    evidenceIds: input.evidenceIds ?? [],
    loadId: input.loadId ?? '',
    requestId: input.requestId ?? 0n,
    at: ctx.timestamp,
  });
}

// A refusal is a committed audit row and a normal return. Never throw.
function requireRole(ctx: Ctx, operation: string, roles: Role[], loadId = '', requestId = 0n): Actor | null {
  const actor = actorFor(ctx);
  if (!actor) {
    log(ctx, { actor: null, operation, outcome: 'refused', reason: 'Sender identity is not bound to a persona.', loadId, requestId });
    return null;
  }
  if (!roles.includes(actor.role as Role)) {
    log(ctx, { actor, operation, outcome: 'refused', reason: `Role ${actor.role} may not call ${operation}.`, loadId, requestId });
    return null;
  }
  return actor;
}

// Project trusted rows into the offline policy input. Nothing here comes from
// the caller except the load and invoice document ids.
function projectReview(ctx: Ctx, loadId: string, invoiceDocumentId: string): { input: ReviewInput; bankVersion: number } | string {
  const load = ctx.db.load.id.find(loadId);
  if (!load) return `Unknown load ${loadId}.`;
  const carrier = ctx.db.carrier.id.find(load.carrierId);
  if (!carrier) return `Load ${loadId} references unknown carrier ${load.carrierId}.`;
  const invoiceDoc = ctx.db.document.id.find(invoiceDocumentId);
  if (!invoiceDoc) return `Unknown document ${invoiceDocumentId}.`;
  const extraction = ctx.db.extraction.documentId.find(invoiceDocumentId);
  if (!extraction) return `No extraction recorded for ${invoiceDocumentId}.`;
  if (extraction.contentHash !== invoiceDoc.contentHash || invoiceDoc.contentHash === '') {
    return `Extraction for ${invoiceDocumentId} does not match the received content hash.`;
  }

  const documents = [...ctx.db.document.iter()].map(d => ({
    id: d.id,
    kind: d.kind as ReviewInput['documents'][number]['kind'],
    carrier_id: d.carrierId,
    load_id: d.loadId ?? null,
    received_at: iso(d.receivedAt),
  }));
  const assignments = [...ctx.db.assignment.carrierId.filter(carrier.id)].map(a => ({
    carrier_id: a.carrierId,
    factor_id: a.factorId,
    effective_at: iso(a.effectiveAt),
    source_document_id: a.sourceDocumentId,
    released_at: a.releasedAt ? iso(a.releasedAt) : null,
  }));
  // Every request in any state reserves its obligation, including rejected
  // and failed ones, until a controller reconciles them.
  const reservations = [...ctx.db.paymentRequest.iter()]
    .filter(r => r.invoiceDocumentId !== invoiceDocumentId || r.loadId !== loadId)
    .map(r => ({ load_id: r.loadId, carrier_id: r.invoiceKey.split('|')[0], invoice_number: r.invoiceKey.split('|')[1] ?? '' }));

  const remitTo: Payee = { kind: extraction.remitToKind as Payee['kind'], id: extraction.remitToId };
  const input: ReviewInput = {
    as_of: iso(ctx.timestamp),
    load: {
      id: load.id, carrier_id: load.carrierId, rate_cents: cents(load.rateCents), delivered: load.delivered,
      rate_document_id: load.rateDocumentId, pod_document_id: load.podDocumentId ?? null,
    },
    carrier: { id: carrier.id, authority: carrier.authority as 'active' | 'revoked' },
    invoice: {
      document_id: invoiceDoc.id, carrier_id: invoiceDoc.carrierId, load_id: extraction.loadReference,
      invoice_number: extraction.invoiceNumber, invoice_at: iso(extraction.invoiceAt), currency: extraction.currency,
      linehaul_cents: cents(extraction.linehaulCents), accessorials_cents: cents(extraction.accessorialsCents),
      total_cents: cents(extraction.totalCents), remit_to: remitTo, confidence: extraction.confidence,
    },
    documents, assignments, reservations,
    bank_change_pending: carrier.bankChangePending,
  };
  return { input, bankVersion: bankVersionFor(ctx, evaluateSettlement(input).payee, carrier.bankVersion) };
}

function bankVersionFor(ctx: Ctx, payee: Payee | null, carrierVersion: number): number {
  if (!payee) return 0;
  if (payee.kind === 'factor') return ctx.db.factor.id.find(payee.id)?.bankVersion ?? 0;
  return carrierVersion;
}

function digestOf(decision: Decision, bankVersion: number, invoice: ReviewInput['invoice']): string {
  return snapshotDigest({
    amount_cents: decision.amount_cents, currency: 'USD', payee: decision.payee, bank_version: bankVersion,
    evidence_ids: decision.evidence_ids, failed_rules: decision.rule_results.filter(r => !r.passed).map(r => r.rule_id),
    invoice,
  });
}

// Trusted rows changed under a live request. The reservation holds and any
// approval is void. The request is re-bound to the current rows so a new
// approval can be made, but only while policy still pays the same party the
// same amount and reserves the same invoice; otherwise it stays pending with
// its old digest, which no approval can match, until a human reviews it.
function refreshSnapshot(ctx: Ctx, actor: Actor, operation: string, request: Request, why: string) {
  const base = { ...request, state: 'pending', updatedAt: ctx.timestamp };
  const projected = projectReview(ctx, request.loadId, request.invoiceDocumentId);
  if (typeof projected === 'string') {
    ctx.db.paymentRequest.id.update({ ...base, lastOutcome: `${why}. ${projected}` });
    log(ctx, { actor, operation, outcome: 'ok', reason: `Request #${request.id} returned to pending. ${projected}`, loadId: request.loadId, requestId: request.id });
    return;
  }
  const decision = evaluateSettlement(projected.input);
  const invoiceKey = `${projected.input.carrier.id}|${normalizeInvoiceNumber(projected.input.invoice.invoice_number)}`;
  if (invoiceKey !== request.invoiceKey) {
    const reason = `${why}; invoice identity changed from ${request.invoiceKey} to ${invoiceKey}. Original reservation retained; reconcile the invoice before approval.`;
    ctx.db.paymentRequest.id.update({ ...base, lastOutcome: reason });
    log(ctx, { actor, operation, outcome: 'held', reason, loadId: request.loadId, requestId: request.id });
    return;
  }
  const payable = decision.decision === 'request_approval' && decision.payee?.kind === request.payeeKind
    && decision.payee?.id === request.payeeId && BigInt(decision.amount_cents ?? 0) === request.amountCents;
  if (!payable) {
    const failed = decision.rule_results.filter(r => !r.passed).map(r => r.rule_id).join(', ');
    ctx.db.paymentRequest.id.update({ ...base, lastOutcome: `${why}; policy now holds this invoice (${failed || 'payee or amount changed'}). No approval can bind to it until that clears.` });
    log(ctx, { actor, operation, outcome: 'held', reason: `Request #${request.id} returned to pending; policy now holds it (${failed || 'payee or amount changed'}).`, ruleResults: decision.rule_results, loadId: request.loadId, requestId: request.id });
    return;
  }
  const digest = digestOf(decision, projected.bankVersion, projected.input.invoice);
  ctx.db.paymentRequest.id.update({ ...base, snapshotDigest: digest, bankVersion: projected.bankVersion, lastOutcome: `${why}; re-bound to bank v${projected.bankVersion}. Needs a new approval.` });
  log(ctx, { actor, operation, outcome: 'ok', reason: `Request #${request.id} returned to pending and re-bound to bank v${projected.bankVersion}; a new approval is required.`, loadId: request.loadId, requestId: request.id });
}

// ---------------------------------------------------------------- lifecycle

export const init = spacetimedb.init(ctx => {
  const personas: Array<[string, Role, bigint, string]> = [
    ['A-agent', 'agent', 0n, 'Remit-To agent'],
    ['A-ap', 'ap_lead', 500_000n, 'Dana Whitfield · AP lead'],
    ['A-controller', 'controller', 5_000_000n, 'Marcus Obi · Controller'],
    ['A-runner', 'runner', 0n, 'Payment runner'],
    ['A-world', 'world', 0n, 'World loader'],
  ];
  for (const [id, role, limit, persona] of personas) {
    ctx.db.actor.insert({ id, role, approvalLimitCents: limit, persona, identity: undefined, boundAt: undefined });
  }
});

// ---------------------------------------------------------------- personas

export const bootstrapPersona = spacetimedb.reducer({ role: t.string() }, (ctx, { role }) => {
  const op = 'bootstrap_persona';
  if (actorFor(ctx)) {
    log(ctx, { actor: actorFor(ctx), operation: op, outcome: 'refused', reason: 'Sender is already bound to a persona.' });
    return;
  }
  const free = [...ctx.db.actor.iter()].find(a => a.role === role && !a.identity);
  if (!free) {
    log(ctx, { actor: null, operation: op, outcome: 'refused', reason: `No unbound persona with role ${role}.` });
    return;
  }
  ctx.db.actor.id.update({ ...free, identity: ctx.sender, boundAt: ctx.timestamp });
  log(ctx, { actor: { ...free, identity: ctx.sender }, operation: op, outcome: 'ok', reason: `Bound ${free.id} (${role}).` });
});

// ---------------------------------------------------------------- world

export const seedWorld = spacetimedb.reducer(ctx => {
  const op = 'seed_world';
  const actor = requireRole(ctx, op, ['world', 'controller']);
  if (!actor) return;
  if ([...ctx.db.load.iter()].length > 0) {
    log(ctx, { actor, operation: op, outcome: 'refused', reason: 'World already seeded.' });
    return;
  }

  ctx.db.carrier.insert({ id: 'C-301', name: 'Ridgeline Transport LLC', authority: 'active', bankVersion: 3, bankLabel: 'First Plains Bank ••4471', bankChangePending: false });
  ctx.db.carrier.insert({ id: 'C-204', name: 'Blue Mesa Freight', authority: 'active', bankVersion: 1, bankLabel: 'Desert Community CU ••0928', bankChangePending: false });
  ctx.db.carrier.insert({ id: 'C-118', name: 'Cascade Haul Co', authority: 'active', bankVersion: 2, bankLabel: 'Pacific Western ••7715', bankChangePending: false });
  ctx.db.carrier.insert({ id: 'C-452', name: 'Northstar Logistics', authority: 'active', bankVersion: 1, bankLabel: 'Summit Bank ••3310', bankChangePending: false });
  ctx.db.factor.insert({ id: 'F-01', name: 'Meridian Capital Factoring', contactEmail: 'ar@meridiancap.example', bankVersion: 2, bankLabel: 'Meridian Operating ••5508' });

  type Doc = [id: string, kind: string, carrierId: string, loadId: string | undefined, title: string, sender: string, receivedAt: string];
  const docs: Doc[] = [
    // Redirect story: L-2041, Ridgeline, factored to Meridian since March.
    ['D-noa-0302', 'noa', 'C-301', undefined, 'Notice of Assignment · Ridgeline → Meridian Capital', 'notices@meridiancap.example', '2026-03-02T16:10:00Z'],
    ['D-rate-2041', 'rate_con', 'C-301', 'L-2041', 'Rate Confirmation L-2041', 'ops@broker.example', '2026-06-01T15:02:00Z'],
    ['D-pod-2041', 'pod', 'C-301', 'L-2041', 'Proof of Delivery L-2041', 'driver-app@broker.example', '2026-06-10T22:41:00Z'],
    ['D-eml-0611', 'email', 'C-301', 'L-2041', 'RE: Updated banking for remittance', 'billing@ridgeline-transport.co', '2026-06-11T14:27:00Z'],
    ['D-inv-0612', 'invoice', 'C-301', 'L-2041', 'Invoice INV-88213', 'billing@ridgeline-transport.co', '2026-06-12T09:15:00Z'],
    // Clean story and its duplicate: L-2037, Blue Mesa.
    ['D-rate-2037', 'rate_con', 'C-204', 'L-2037', 'Rate Confirmation L-2037', 'ops@broker.example', '2026-06-02T17:30:00Z'],
    ['D-pod-2037', 'pod', 'C-204', 'L-2037', 'Proof of Delivery L-2037', 'driver-app@broker.example', '2026-06-09T20:05:00Z'],
    ['D-inv-5521', 'invoice', 'C-204', 'L-2037', 'Invoice INV-5521', 'ar@bluemesafreight.example', '2026-06-10T13:40:00Z'],
    ['D-inv-5521R', 'invoice', 'C-204', 'L-2037', 'Invoice INV-5521-R', 'ar@bluemesafreight.example', '2026-06-24T08:12:00Z'],
    // Filler clean loads.
    ['D-rate-2033', 'rate_con', 'C-118', 'L-2033', 'Rate Confirmation L-2033', 'ops@broker.example', '2026-06-03T16:00:00Z'],
    ['D-pod-2033', 'pod', 'C-118', 'L-2033', 'Proof of Delivery L-2033', 'driver-app@broker.example', '2026-06-08T19:22:00Z'],
    ['D-inv-7710', 'invoice', 'C-118', 'L-2033', 'Invoice INV-7710', 'billing@cascadehaul.example', '2026-06-09T11:05:00Z'],
    ['D-rate-2029', 'rate_con', 'C-452', 'L-2029', 'Rate Confirmation L-2029', 'ops@broker.example', '2026-06-04T14:45:00Z'],
    ['D-pod-2029', 'pod', 'C-452', 'L-2029', 'Proof of Delivery L-2029', 'driver-app@broker.example', '2026-06-11T23:10:00Z'],
    ['D-inv-3302', 'invoice', 'C-452', 'L-2029', 'Invoice INV-3302', 'ap@northstarlogistics.example', '2026-06-12T15:30:00Z'],
  ];
  for (const [id, kind, carrierId, loadId, title, sender, receivedAt] of docs) {
    ctx.db.document.insert({ id, kind, carrierId, loadId, title, sender, receivedAt: ts(receivedAt), contentHash: '', path: '' });
  }

  ctx.db.assignment.insert({ id: 0n, carrierId: 'C-301', factorId: 'F-01', effectiveAt: ts('2026-03-02T16:10:00Z'), sourceDocumentId: 'D-noa-0302', releasedAt: undefined, verifiedBy: 'A-controller' });

  type LoadRow = [id: string, carrierId: string, lane: string, customer: string, deliveredAt: string, rateCents: bigint];
  const loads: LoadRow[] = [
    ['L-2041', 'C-301', 'Stockton, CA → Reno, NV', 'Sierra Beverage Co', '2026-06-10T22:30:00Z', 240_000n],
    ['L-2037', 'C-204', 'Fresno, CA → Phoenix, AZ', 'Valley Produce Partners', '2026-06-09T19:50:00Z', 185_000n],
    ['L-2033', 'C-118', 'Oakland, CA → Sacramento, CA', 'Bayline Paper', '2026-06-08T19:10:00Z', 92_500n],
    ['L-2029', 'C-452', 'Salinas, CA → Las Vegas, NV', 'Monterey Greens', '2026-06-11T22:55:00Z', 310_000n],
  ];
  for (const [id, carrierId, lane, customer, deliveredAt, rateCents] of loads) {
    const suffix = id.slice(2);
    ctx.db.load.insert({ id, carrierId, lane, customer, delivered: true, deliveredAt: ts(deliveredAt), rateCents, rateDocumentId: `D-rate-${suffix}`, podDocumentId: `D-pod-${suffix}` });
  }
  log(ctx, { actor, operation: op, outcome: 'ok', reason: `Seeded ${loads.length} loads, ${docs.length} documents, 1 verified assignment.` });
});

// Attaches the rendered file's hash to a seeded document exactly once.
export const attachDocumentFile = spacetimedb.reducer(
  { documentId: t.string(), contentHash: t.string(), path: t.string() },
  (ctx, { documentId, contentHash, path }) => {
    const op = 'attach_document_file';
    const actor = requireRole(ctx, op, ['world', 'controller']);
    if (!actor) return;
    const doc = ctx.db.document.id.find(documentId);
    if (!doc) { log(ctx, { actor, operation: op, outcome: 'refused', reason: `Unknown document ${documentId}.` }); return; }
    if (doc.contentHash !== '' && doc.contentHash !== contentHash) {
      log(ctx, { actor, operation: op, outcome: 'refused', reason: `Document ${documentId} already has a different content hash; received evidence is immutable.` });
      return;
    }
    if (contentHash === '') { log(ctx, { actor, operation: op, outcome: 'refused', reason: 'Content hash is required.' }); return; }
    ctx.db.document.id.update({ ...doc, contentHash, path });
    log(ctx, { actor, operation: op, outcome: 'ok', reason: `Attached ${documentId} ${contentHash.slice(0, 12)}.`, loadId: doc.loadId ?? '' });
  },
);

// Controller-only bank directory edit. Bumps the version so any approval
// bound to the old destination goes stale.
export const updateCarrierBank = spacetimedb.reducer(
  { carrierId: t.string(), bankLabel: t.string(), pending: t.bool() },
  (ctx, { carrierId, bankLabel, pending }) => {
    const op = 'update_carrier_bank';
    const actor = requireRole(ctx, op, ['controller']);
    if (!actor) return;
    const carrier = ctx.db.carrier.id.find(carrierId);
    if (!carrier) { log(ctx, { actor, operation: op, outcome: 'refused', reason: `Unknown carrier ${carrierId}.` }); return; }
    ctx.db.carrier.id.update({ ...carrier, bankLabel, bankVersion: carrier.bankVersion + 1, bankChangePending: pending });
    log(ctx, { actor, operation: op, outcome: 'ok', reason: `Carrier ${carrierId} bank destination now v${carrier.bankVersion + 1}${pending ? ' (callback pending)' : ''}.` });
    // Anything not yet dispatched to this carrier was bound to the old destination.
    const live = [...ctx.db.paymentRequest.iter()].filter(r => r.payeeKind === 'carrier' && r.payeeId === carrierId && (r.state === 'pending' || r.state === 'approved'));
    for (const r of live) {
      refreshSnapshot(ctx, actor, op, r, r.state === 'approved' ? 'Approval invalidated: bank destination changed before dispatch' : 'Bank destination changed before approval');
    }
  },
);

// ---------------------------------------------------------------- agent

export const recordExtraction = spacetimedb.reducer(
  {
    documentId: t.string(), contentHash: t.string(), invoiceNumber: t.string(), loadReference: t.string(), invoiceAt: t.timestamp(),
    currency: t.string(), linehaulCents: t.u64(), accessorialsCents: t.u64(), totalCents: t.u64(),
    remitToKind: t.string(), remitToId: t.string(), confidence: t.f64(),
    model: t.string(), promptVersion: t.string(), method: t.string(), explanation: t.string(),
  },
  (ctx, a) => {
    const op = 'record_extraction';
    const actor = requireRole(ctx, op, ['agent']);
    if (!actor) return;
    const doc = ctx.db.document.id.find(a.documentId);
    if (!doc) { log(ctx, { actor, operation: op, outcome: 'refused', reason: `Unknown document ${a.documentId}.` }); return; }
    if (doc.kind !== 'invoice') { log(ctx, { actor, operation: op, outcome: 'refused', reason: `Document ${a.documentId} is a ${doc.kind}, not an invoice.`, loadId: doc.loadId ?? '' }); return; }
    if (doc.contentHash === '' || doc.contentHash !== a.contentHash) {
      log(ctx, { actor, operation: op, outcome: 'refused', reason: `Extraction hash does not match the received content of ${a.documentId}.`, loadId: doc.loadId ?? '' });
      return;
    }
    const row = {
      id: 0n, documentId: a.documentId, contentHash: a.contentHash, invoiceNumber: a.invoiceNumber, loadReference: a.loadReference, invoiceAt: a.invoiceAt,
      currency: a.currency, linehaulCents: a.linehaulCents, accessorialsCents: a.accessorialsCents, totalCents: a.totalCents,
      remitToKind: a.remitToKind, remitToId: a.remitToId, confidence: a.confidence, model: a.model, promptVersion: a.promptVersion,
      method: a.method, explanation: a.explanation, recordedBy: ctx.sender, recordedAt: ctx.timestamp,
    };
    const existing = ctx.db.extraction.documentId.find(a.documentId);
    if (existing) ctx.db.extraction.id.update({ ...row, id: existing.id });
    else ctx.db.extraction.insert(row);
    log(ctx, { actor, operation: op, outcome: 'ok', reason: `Recorded ${a.method} extraction of ${a.documentId} (${a.invoiceNumber}, confidence ${a.confidence}).`, loadId: doc.loadId ?? '', evidenceIds: [a.documentId] });
    const request = ctx.db.paymentRequest.loadId.find(doc.loadId ?? '');
    if (request && request.invoiceDocumentId === doc.id && (request.state === 'pending' || request.state === 'approved')) {
      const projected = projectReview(ctx, request.loadId, doc.id);
      const current = typeof projected === 'string' ? '' : digestOf(evaluateSettlement(projected.input), projected.bankVersion, projected.input.invoice);
      if (current !== request.snapshotDigest) {
        refreshSnapshot(ctx, actor, op, request, 'Approval invalidated: extracted invoice facts changed');
      }
    }
  },
);

export const proposeSettlement = spacetimedb.reducer(
  { loadId: t.string(), invoiceDocumentId: t.string(), explanation: t.string(), escalationEmail: t.string() },
  (ctx, { loadId, invoiceDocumentId, explanation, escalationEmail }) => {
    const op = 'propose_settlement';
    const actor = requireRole(ctx, op, ['agent'], loadId);
    if (!actor) return;
    const projected = projectReview(ctx, loadId, invoiceDocumentId);
    if (typeof projected === 'string') { log(ctx, { actor, operation: op, outcome: 'refused', reason: projected, loadId }); return; }
    const decision = evaluateSettlement(projected.input);
    const digest = digestOf(decision, projected.bankVersion, projected.input.invoice);
    ctx.db.settlement.insert({
      id: 0n, loadId, invoiceDocumentId, invoiceNumber: normalizeInvoiceNumber(projected.input.invoice.invoice_number),
      agreedCents: BigInt(decision.amount_cents ?? 0), payeeKind: decision.payee?.kind ?? '', payeeId: decision.payee?.id ?? '',
      decision: decision.decision,
      ruleResults: decision.rule_results.map(r => ({ ruleId: r.rule_id, passed: r.passed, reason: r.reason })),
      evidenceIds: decision.evidence_ids, snapshotDigest: digest, question: decision.question ?? '',
      explanation, escalationEmail, proposedBy: actor.id, proposedAt: ctx.timestamp,
    });
    log(ctx, {
      actor, operation: op, outcome: decision.decision === 'hold' ? 'held' : 'ok',
      reason: decision.decision === 'hold'
        ? `Held: ${decision.rule_results.filter(r => !r.passed).map(r => r.rule_id).join(', ')} failed.`
        : `Ready for approval: ${decision.amount_cents} cents to ${decision.payee?.kind} ${decision.payee?.id}.`,
      ruleResults: decision.rule_results, evidenceIds: decision.evidence_ids, loadId,
    });
  },
);

export const requestPayment = spacetimedb.reducer(
  { loadId: t.string(), invoiceDocumentId: t.string() },
  (ctx, { loadId, invoiceDocumentId }) => {
    const op = 'request_payment';
    const actor = requireRole(ctx, op, ['agent', 'ap_lead'], loadId);
    if (!actor) return;
    const projected = projectReview(ctx, loadId, invoiceDocumentId);
    if (typeof projected === 'string') { log(ctx, { actor, operation: op, outcome: 'refused', reason: projected, loadId }); return; }
    const decision = evaluateSettlement(projected.input);
    if (decision.decision !== 'request_approval' || !decision.payee || !decision.amount_cents) {
      log(ctx, {
        actor, operation: op, outcome: 'refused',
        reason: `Policy holds this invoice: ${decision.rule_results.filter(r => !r.passed).map(r => r.rule_id).join(', ')} failed. No request created.`,
        ruleResults: decision.rule_results, evidenceIds: decision.evidence_ids, loadId,
      });
      return;
    }
    const invoiceKey = `${projected.input.carrier.id}|${normalizeInvoiceNumber(projected.input.invoice.invoice_number)}`;
    // Serialized reducers make this check authoritative; the unique indexes on
    // loadId and invoiceKey are the backstop if it were ever bypassed.
    if (ctx.db.paymentRequest.loadId.find(loadId) || ctx.db.paymentRequest.invoiceKey.find(invoiceKey)) {
      log(ctx, { actor, operation: op, outcome: 'refused', reason: `Load ${loadId} or invoice ${invoiceKey} is already reserved by an existing request.`, loadId, ruleResults: decision.rule_results });
      return;
    }
    const latest = [...ctx.db.settlement.loadId.filter(loadId)].filter(s => s.invoiceDocumentId === invoiceDocumentId).sort((a, b) => Number(b.id - a.id))[0];
    const request = ctx.db.paymentRequest.insert({
      id: 0n, loadId, invoiceKey, invoiceDocumentId, settlementId: latest?.id ?? 0n,
      amountCents: BigInt(decision.amount_cents), currency: 'USD', payeeKind: decision.payee.kind, payeeId: decision.payee.id,
      bankVersion: projected.bankVersion, snapshotDigest: digestOf(decision, projected.bankVersion, projected.input.invoice), requestedBy: actor.id,
      state: 'pending', idempotencyKey: '', frozenPayload: '', transferId: '', lastOutcome: '',
      createdAt: ctx.timestamp, updatedAt: ctx.timestamp,
    });
    log(ctx, {
      actor, operation: op, outcome: 'reserved',
      reason: `Reserved ${loadId} and ${invoiceKey}; request #${request.id} pending approval for ${decision.amount_cents} cents to ${decision.payee.kind} ${decision.payee.id}.`,
      ruleResults: decision.rule_results, evidenceIds: decision.evidence_ids, loadId, requestId: request.id,
    });
  },
);

// ---------------------------------------------------------------- approval

function approvalDecision(ctx: Ctx, operation: string, requestId: bigint, snapshot: string, decision: 'approved' | 'rejected', reason: string) {
  const request = ctx.db.paymentRequest.id.find(requestId);
  const actor = requireRole(ctx, operation, ['ap_lead', 'controller'], request?.loadId ?? '', requestId);
  if (!actor) return;
  if (!request) { log(ctx, { actor, operation, outcome: 'refused', reason: `Unknown request #${requestId}.`, requestId }); return; }
  const projected = projectReview(ctx, request.loadId, request.invoiceDocumentId);
  const now = typeof projected === 'string' ? null : evaluateSettlement(projected.input);
  const current = now && typeof projected !== 'string' ? digestOf(now, projected.bankVersion, projected.input.invoice) : '';
  if (decision === 'approved' && request.state === 'pending' && actor.id !== request.requestedBy) {
    if (now && now.decision !== 'request_approval') {
      const failed = now.rule_results.filter(r => !r.passed).map(r => r.rule_id).join(', ');
      log(ctx, { actor, operation, outcome: 'refused', reason: `Policy now holds this invoice (${failed} failed); request #${requestId} cannot be approved.`, ruleResults: now.rule_results, loadId: request.loadId, requestId });
      return;
    }
    if (current !== '' && current !== request.snapshotDigest) {
      // The stored snapshot is stale against trusted rows. Re-bind, then refuse
      // this approval so the approver sees and approves the new snapshot.
      refreshSnapshot(ctx, actor, operation, request, 'Trusted rows changed since this request');
      log(ctx, { actor, operation, outcome: 'refused', reason: `The approval snapshot is stale: trusted rows changed since request #${requestId} was made. It has been re-bound; approve again against the new snapshot.`, loadId: request.loadId, requestId });
      return;
    }
  }
  const check = checkApproval({
    actor: { id: actor.id, role: actor.role as 'ap_lead' | 'controller', approval_limit_cents: cents(actor.approvalLimitCents) },
    request: {
      requested_by: request.requestedBy, amount_cents: cents(request.amountCents), status: request.state,
      snapshot_current: snapshot === request.snapshotDigest && current === request.snapshotDigest,
    },
  });
  if (decision === 'rejected' && reason.trim() === '') {
    log(ctx, { actor, operation, outcome: 'refused', reason: 'A rejection needs a reason.', loadId: request.loadId, requestId });
    return;
  }
  // Rejection follows the same role, self-approval and pending checks; it may
  // proceed on a stale snapshot because it only withdraws the request.
  const allowed = check.allowed || (decision === 'rejected' && check.reason.includes('stale'));
  if (!allowed) {
    log(ctx, { actor, operation, outcome: 'refused', reason: check.reason, loadId: request.loadId, requestId });
    return;
  }
  ctx.db.approval.insert({ id: 0n, requestId, snapshotDigest: request.snapshotDigest, approverId: actor.id, approverIdentity: ctx.sender, decision, reason, at: ctx.timestamp });
  ctx.db.paymentRequest.id.update({ ...request, state: decision, updatedAt: ctx.timestamp });
  log(ctx, { actor, operation, outcome: 'ok', reason: `${actor.id} ${decision} request #${requestId}${reason ? `: ${reason}` : ''}.`, loadId: request.loadId, requestId });
}

export const approvePayment = spacetimedb.reducer(
  { requestId: t.u64(), snapshotDigest: t.string() },
  (ctx, { requestId, snapshotDigest }) => approvalDecision(ctx, 'approve_payment', requestId, snapshotDigest, 'approved', ''),
);

export const rejectPayment = spacetimedb.reducer(
  { requestId: t.u64(), snapshotDigest: t.string(), reason: t.string() },
  (ctx, { requestId, snapshotDigest, reason }) => approvalDecision(ctx, 'reject_payment', requestId, snapshotDigest, 'rejected', reason),
);

// ---------------------------------------------------------------- runner

export const claimPayment = spacetimedb.reducer(
  { requestId: t.u64(), idempotencyKey: t.string() },
  (ctx, { requestId, idempotencyKey }) => {
    const op = 'claim_payment';
    const request = ctx.db.paymentRequest.id.find(requestId);
    const actor = requireRole(ctx, op, ['runner'], request?.loadId ?? '', requestId);
    if (!actor) return;
    if (!request) { log(ctx, { actor, operation: op, outcome: 'refused', reason: `Unknown request #${requestId}.`, requestId }); return; }
    if (request.state !== 'approved') { log(ctx, { actor, operation: op, outcome: 'refused', reason: `Request #${requestId} is ${request.state}, not approved.`, loadId: request.loadId, requestId }); return; }
    if (idempotencyKey.trim() === '') { log(ctx, { actor, operation: op, outcome: 'refused', reason: 'An idempotency key is required before dispatch.', loadId: request.loadId, requestId }); return; }
    const projected = projectReview(ctx, request.loadId, request.invoiceDocumentId);
    const current = typeof projected === 'string' ? '' : digestOf(evaluateSettlement(projected.input), projected.bankVersion, projected.input.invoice);
    if (current !== request.snapshotDigest) {
      // The approval was bound to a snapshot that no longer matches trusted rows.
      log(ctx, { actor, operation: op, outcome: 'refused', reason: `Snapshot changed since approval; request #${requestId} returned to pending.`, loadId: request.loadId, requestId });
      refreshSnapshot(ctx, actor, op, request, 'Approval invalidated: snapshot changed before dispatch');
      return;
    }
    const payee = request.payeeKind === 'factor' ? ctx.db.factor.id.find(request.payeeId) : ctx.db.carrier.id.find(request.payeeId);
    const frozenPayload = JSON.stringify({
      idempotency_key: idempotencyKey, request_id: String(requestId), amount_cents: String(request.amountCents), currency: request.currency,
      payee: { kind: request.payeeKind, id: request.payeeId, name: payee?.name ?? '', bank_version: request.bankVersion, bank_label: payee?.bankLabel ?? '' },
      load_id: request.loadId, snapshot_digest: request.snapshotDigest,
    });
    ctx.db.paymentRequest.id.update({ ...request, state: 'submitting', idempotencyKey, frozenPayload, updatedAt: ctx.timestamp });
    log(ctx, { actor, operation: op, outcome: 'ok', reason: `Claimed request #${requestId} with key ${idempotencyKey}; payload frozen.`, loadId: request.loadId, requestId });
  },
);

const OUTCOME_TRANSITIONS: Record<string, string[]> = {
  submitting: ['submitted', 'unknown', 'failed'],
  unknown: ['submitted', 'failed'],
  submitted: ['simulated_settled', 'failed'],
};

export const recordPaymentOutcome = spacetimedb.reducer(
  { requestId: t.u64(), idempotencyKey: t.string(), outcome: t.string(), transferId: t.string(), detail: t.string() },
  (ctx, { requestId, idempotencyKey, outcome, transferId, detail }) => {
    const op = 'record_payment_outcome';
    const actor = requireRole(ctx, op, ['runner']);
    if (!actor) return;
    const request = ctx.db.paymentRequest.id.find(requestId);
    if (!request) { log(ctx, { actor, operation: op, outcome: 'refused', reason: `Unknown request #${requestId}.`, requestId }); return; }
    if (request.idempotencyKey !== idempotencyKey) { log(ctx, { actor, operation: op, outcome: 'refused', reason: `Idempotency key does not match request #${requestId}.`, loadId: request.loadId, requestId }); return; }
    // Reducers serialize this ownership check with the update below. Empty
    // transfer ids mean no provider transfer has been recorded yet.
    if (transferId !== '') {
      const owner = [...ctx.db.paymentRequest.iter()].find(r => r.id !== requestId && r.transferId === transferId);
      if (owner) {
        log(ctx, { actor, operation: op, outcome: 'refused', reason: `Transfer ${transferId} already belongs to request #${owner.id}.`, loadId: request.loadId, requestId });
        return;
      }
    }
    if (request.transferId !== '' && transferId !== '' && request.transferId !== transferId) {
      log(ctx, { actor, operation: op, outcome: 'refused', reason: `Transfer ${transferId} does not match recorded transfer ${request.transferId} for request #${requestId}.`, loadId: request.loadId, requestId });
      return;
    }
    if (request.state === outcome) {
      log(ctx, { actor, operation: op, outcome: 'ok', reason: `Duplicate ${outcome} notification for request #${requestId}; no change.`, loadId: request.loadId, requestId });
      return;
    }
    if (!(OUTCOME_TRANSITIONS[request.state] ?? []).includes(outcome)) {
      log(ctx, { actor, operation: op, outcome: 'refused', reason: `Transition ${request.state} → ${outcome} is not permitted.`, loadId: request.loadId, requestId });
      return;
    }
    ctx.db.paymentRequest.id.update({ ...request, state: outcome, transferId: transferId || request.transferId, lastOutcome: detail, updatedAt: ctx.timestamp });
    log(ctx, { actor, operation: op, outcome: 'ok', reason: `Request #${requestId} ${request.state} → ${outcome}${transferId ? ` (transfer ${transferId})` : ''}. ${detail}`.trim(), loadId: request.loadId, requestId });
  },
);
