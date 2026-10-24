import { schema, table, t } from 'spacetimedb/server';

export const RuleResult = t.object('RuleResult', {
  ruleId: t.string(),
  passed: t.bool(),
  reason: t.string(),
});

// Seeded personas. `identity` is bound once by bootstrap_persona; it is the
// only source of authority for every other reducer.
const actor = table({ name: 'actor', public: true }, {
  id: t.string().primaryKey(),
  role: t.string(),                // agent | ap_lead | controller | runner | world
  approvalLimitCents: t.u64(),
  persona: t.string(),
  identity: t.option(t.identity()),
  boundAt: t.option(t.timestamp()),
});

const carrier = table({ name: 'carrier', public: true }, {
  id: t.string().primaryKey(),
  name: t.string(),
  authority: t.string(),           // active | revoked (seeded)
  bankVersion: t.u32(),
  bankLabel: t.string(),
  bankChangePending: t.bool(),
});

const factor = table({ name: 'factor', public: true }, {
  id: t.string().primaryKey(),
  name: t.string(),
  contactEmail: t.string(),
  bankVersion: t.u32(),
  bankLabel: t.string(),
});

const assignment = table({ name: 'assignment', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  carrierId: t.string().index('btree'),
  factorId: t.string(),
  effectiveAt: t.timestamp(),
  sourceDocumentId: t.string(),
  releasedAt: t.option(t.timestamp()),
  verifiedBy: t.string(),
});

const load = table({ name: 'load', public: true }, {
  id: t.string().primaryKey(),
  carrierId: t.string().index('btree'),
  lane: t.string(),
  customer: t.string(),
  delivered: t.bool(),
  deliveredAt: t.option(t.timestamp()),
  rateCents: t.u64(),
  rateDocumentId: t.string(),
  podDocumentId: t.option(t.string()),
});

// Received evidence. Rows are inserted by the seed; attach_document_file sets
// the content hash once, when the rendered file exists.
const document = table({ name: 'document', public: true }, {
  id: t.string().primaryKey(),
  kind: t.string(),                // invoice | rate_con | pod | noa | email
  carrierId: t.string().index('btree'),
  loadId: t.option(t.string()),
  title: t.string(),
  sender: t.string(),
  receivedAt: t.timestamp(),
  contentHash: t.string(),
  path: t.string(),
});

// Typed fields the agent read from an invoice document. Prose lives in
// `explanation`; the policy never reads it.
const extraction = table({ name: 'extraction', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  documentId: t.string().unique(),
  contentHash: t.string(),
  invoiceNumber: t.string(),
  invoiceAt: t.timestamp(),
  currency: t.string(),
  linehaulCents: t.u64(),
  accessorialsCents: t.u64(),
  totalCents: t.u64(),
  remitToKind: t.string(),
  remitToId: t.string(),
  confidence: t.f64(),
  model: t.string(),
  promptVersion: t.string(),
  method: t.string(),              // claude | manual
  explanation: t.string(),
  recordedBy: t.identity(),
  recordedAt: t.timestamp(),
});

const settlement = table({ name: 'settlement', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  loadId: t.string().index('btree'),
  invoiceDocumentId: t.string().index('btree'),
  invoiceNumber: t.string(),
  agreedCents: t.u64(),
  payeeKind: t.string(),           // carrier | factor | '' when undecidable
  payeeId: t.string(),
  decision: t.string(),            // request_approval | hold
  ruleResults: t.array(RuleResult),
  evidenceIds: t.array(t.string()),
  snapshotDigest: t.string(),
  question: t.string(),
  explanation: t.string(),
  escalationEmail: t.string(),
  proposedBy: t.string(),
  proposedAt: t.timestamp(),
});

// The unique loadId and invoiceKey indexes are the reservation.
const paymentRequest = table({ name: 'payment_request', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  loadId: t.string().unique(),
  invoiceKey: t.string().unique(),
  invoiceDocumentId: t.string(),
  settlementId: t.u64(),
  amountCents: t.u64(),
  currency: t.string(),
  payeeKind: t.string(),
  payeeId: t.string(),
  bankVersion: t.u32(),
  snapshotDigest: t.string(),
  requestedBy: t.string(),
  state: t.string(),               // pending | approved | rejected | submitting | submitted | unknown | failed | simulated_settled
  idempotencyKey: t.string(),
  frozenPayload: t.string(),
  transferId: t.string(),
  lastOutcome: t.string(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const approval = table({ name: 'approval', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  requestId: t.u64().index('btree'),
  snapshotDigest: t.string(),
  approverId: t.string(),
  approverIdentity: t.identity(),
  decision: t.string(),            // approved | rejected
  reason: t.string(),
  at: t.timestamp(),
});

// Append-only. Refusals are rows here, never thrown errors.
const decisionLog = table({ name: 'decision_log', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  actorId: t.string(),
  actorIdentity: t.identity(),
  operation: t.string(),
  outcome: t.string(),             // ok | refused | reserved | held
  reason: t.string(),
  ruleResults: t.array(RuleResult),
  evidenceIds: t.array(t.string()),
  loadId: t.string(),
  requestId: t.u64(),
  at: t.timestamp(),
});

const spacetimedb = schema({
  actor, carrier, factor, assignment, load, document, extraction,
  settlement, paymentRequest, approval, decisionLog,
});
export default spacetimedb;
