import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Timestamp } from "spacetimedb";
import { connect, ensurePersona, sleep } from "./lib/connect.ts";
import type { DbConnection } from "../bindings/index.ts";

// Live integration test against a freshly published local database.
// Run `npm run reset` first; every persona identity is rebound on a fresh DB.

const conns: Record<string, DbConnection> = {};
const ts = (iso: string) => new Timestamp(BigInt(Date.parse(iso)) * 1000n);
const logs = (c: DbConnection, op?: string) => [...c.db.decisionLog.iter()].filter(l => !op || l.operation === op).sort((a, b) => Number(a.id - b.id));
const lastLog = (c: DbConnection, op: string) => logs(c, op).at(-1)!;
const requestFor = (c: DbConnection, loadId: string) => [...c.db.paymentRequest.iter()].find(r => r.loadId === loadId);
const hashFor = (id: string) => `sha256-test-${id}`;
const count = (table: { count(): bigint | number }) => Number(table.count());

before(async () => {
  for (const p of ["world", "agent", "ap_lead", "controller", "runner"] as const) {
    conns[p] = await connect(p);
    await ensurePersona(conns[p], p);
  }
  await sleep(150); // let every cache receive the last binding
});
after(() => { for (const c of Object.values(conns)) c.disconnect(); });

test("personas are bound once, by first claim, and a second claim is refused", async () => {
  const { world, agent } = conns;
  const bound = [...world.db.actor.iter()].filter(a => a.identity);
  assert.equal(bound.length, 5);
  await agent.reducers.bootstrapPersona({ role: "controller" });
  assert.match(lastLog(agent, "bootstrap_persona").reason, /already bound/);
  assert.equal([...agent.db.actor.iter()].filter(a => a.role === "controller" && a.identity)!.length, 1);
});

test("seed_world is controller/world only and idempotent", async () => {
  const { world, agent } = conns;
  if (count(world.db.load) === 0) await world.reducers.seedWorld();
  assert.equal(count(world.db.load), 4);
  assert.equal(count(world.db.document), 15);
  assert.equal(count(world.db.assignment), 1);
  await world.reducers.seedWorld();
  assert.match(lastLog(world, "seed_world").reason, /already seeded/);
  await agent.reducers.seedWorld();
  assert.match(lastLog(agent, "seed_world").reason, /Role agent may not/);
});

test("document hashes attach once and are then immutable", async () => {
  const { world } = conns;
  for (const d of world.db.document.iter()) {
    if (d.contentHash === "") await world.reducers.attachDocumentFile({ documentId: d.id, contentHash: hashFor(d.id), path: `world/out/${d.id}.pdf` });
  }
  assert.ok([...world.db.document.iter()].every(d => d.contentHash !== ""));
  await world.reducers.attachDocumentFile({ documentId: "D-inv-5521", contentHash: "tampered", path: "x" });
  assert.match(lastLog(world, "attach_document_file").reason, /immutable/);
  assert.equal(world.db.document.id.find("D-inv-5521")!.contentHash, hashFor("D-inv-5521"));
});

async function extract(c: DbConnection, documentId: string, invoiceNumber: string, cents: bigint, remitToKind: string, remitToId: string, invoiceAt: string) {
  await c.reducers.recordExtraction({
    documentId, contentHash: hashFor(documentId), invoiceNumber, invoiceAt: ts(invoiceAt), currency: "USD",
    linehaulCents: cents, accessorialsCents: 0n, totalCents: cents, remitToKind, remitToId, confidence: 0.98,
    model: "test", promptVersion: "test", method: "manual", explanation: "test fixture",
  });
}

test("only the agent records extractions, and only against the received hash", async () => {
  const { agent, ap_lead } = conns;
  await ap_lead.reducers.recordExtraction({
    documentId: "D-inv-5521", contentHash: hashFor("D-inv-5521"), invoiceNumber: "X", invoiceAt: ts("2026-06-10T13:00:00Z"), currency: "USD",
    linehaulCents: 1n, accessorialsCents: 0n, totalCents: 1n, remitToKind: "carrier", remitToId: "C-204", confidence: 1,
    model: "t", promptVersion: "t", method: "manual", explanation: "",
  });
  assert.match(lastLog(ap_lead, "record_extraction").reason, /Role ap_lead may not/);
  await agent.reducers.recordExtraction({
    documentId: "D-inv-5521", contentHash: "wrong", invoiceNumber: "X", invoiceAt: ts("2026-06-10T13:00:00Z"), currency: "USD",
    linehaulCents: 1n, accessorialsCents: 0n, totalCents: 1n, remitToKind: "carrier", remitToId: "C-204", confidence: 1,
    model: "t", promptVersion: "t", method: "manual", explanation: "",
  });
  assert.match(lastLog(agent, "record_extraction").reason, /hash does not match/);
  assert.equal(count(agent.db.extraction), 0);

  await extract(agent, "D-inv-0612", "INV-88213", 240_000n, "carrier", "C-301", "2026-06-12T09:00:00Z");
  await extract(agent, "D-inv-5521", "INV-5521", 185_000n, "carrier", "C-204", "2026-06-10T13:30:00Z");
  await extract(agent, "D-inv-5521R", "INV-5521-R", 185_000n, "carrier", "C-204", "2026-06-24T08:00:00Z");
  await extract(agent, "D-inv-7710", "INV-7710", 92_500n, "carrier", "C-118", "2026-06-09T11:00:00Z");
  await extract(agent, "D-inv-3302", "INV-3302", 310_000n, "carrier", "C-452", "2026-06-12T15:00:00Z");
  assert.equal(count(agent.db.extraction), 5);
});

test("redirect: the June invoice is held against the March NOA and no request is created", async () => {
  const { agent } = conns;
  await agent.reducers.proposeSettlement({ loadId: "L-2041", invoiceDocumentId: "D-inv-0612", explanation: "e", escalationEmail: "m" });
  const s = [...agent.db.settlement.iter()].find(x => x.loadId === "L-2041")!;
  assert.equal(s.decision, "hold");
  assert.deepEqual([s.payeeKind, s.payeeId], ["factor", "F-01"]);
  assert.ok(s.ruleResults.some(r => r.ruleId === "R2" && !r.passed));
  assert.ok(s.evidenceIds.includes("D-noa-0302"));
  assert.equal(lastLog(agent, "propose_settlement").outcome, "held");

  await agent.reducers.requestPayment({ loadId: "L-2041", invoiceDocumentId: "D-inv-0612" });
  const refusal = lastLog(agent, "request_payment");
  assert.equal(refusal.outcome, "refused");
  assert.ok(refusal.ruleResults.some(r => r.ruleId === "R2" && !r.passed));
  assert.equal(requestFor(agent, "L-2041"), undefined);
});

test("clean: the agent reserves the load; the re-bill under a new number is held by the reservation", async () => {
  const { agent } = conns;
  await agent.reducers.proposeSettlement({ loadId: "L-2037", invoiceDocumentId: "D-inv-5521", explanation: "", escalationEmail: "" });
  await agent.reducers.requestPayment({ loadId: "L-2037", invoiceDocumentId: "D-inv-5521" });
  const req = requestFor(agent, "L-2037")!;
  assert.equal(req.state, "pending");
  assert.equal(req.amountCents, 185_000n);
  assert.equal(req.invoiceKey, "C-204|INV-5521");
  assert.equal(req.requestedBy, "A-agent");
  assert.equal(lastLog(agent, "request_payment").outcome, "reserved");

  await agent.reducers.proposeSettlement({ loadId: "L-2037", invoiceDocumentId: "D-inv-5521R", explanation: "", escalationEmail: "" });
  const dup = [...agent.db.settlement.iter()].find(x => x.invoiceDocumentId === "D-inv-5521R")!;
  assert.equal(dup.decision, "hold");
  assert.ok(dup.ruleResults.some(r => r.ruleId === "R3" && !r.passed));
  await agent.reducers.requestPayment({ loadId: "L-2037", invoiceDocumentId: "D-inv-5521R" });
  assert.equal(lastLog(agent, "request_payment").outcome, "refused");
  assert.equal([...agent.db.paymentRequest.iter()].filter(r => r.loadId === "L-2037").length, 1);
});

test("duplicate race: two concurrent requests for one load leave one reservation and one committed refusal", async () => {
  const { agent, ap_lead } = conns;
  const before = logs(agent, "request_payment").length;
  await Promise.all([
    agent.reducers.requestPayment({ loadId: "L-2033", invoiceDocumentId: "D-inv-7710" }),
    ap_lead.reducers.requestPayment({ loadId: "L-2033", invoiceDocumentId: "D-inv-7710" }),
  ]);
  await sleep(150);
  const rows = [...agent.db.paymentRequest.iter()].filter(r => r.loadId === "L-2033");
  assert.equal(rows.length, 1);
  const outcomes = logs(agent, "request_payment").slice(before).map(l => l.outcome).sort();
  assert.deepEqual(outcomes, ["refused", "reserved"]);
});

test("separation of duties: self-approval and agent approval are refused; the controller approves", async () => {
  const { agent, ap_lead, controller } = conns;
  await ap_lead.reducers.requestPayment({ loadId: "L-2029", invoiceDocumentId: "D-inv-3302" });
  const req = requestFor(ap_lead, "L-2029")!;
  assert.equal(req.requestedBy, "A-ap");

  await ap_lead.reducers.approvePayment({ requestId: req.id, snapshotDigest: req.snapshotDigest });
  assert.match(lastLog(ap_lead, "approve_payment").reason, /cannot approve their own/);
  await agent.reducers.approvePayment({ requestId: req.id, snapshotDigest: req.snapshotDigest });
  assert.match(lastLog(agent, "approve_payment").reason, /Role agent may not/);
  await controller.reducers.approvePayment({ requestId: req.id, snapshotDigest: "stale-digest" });
  assert.match(lastLog(controller, "approve_payment").reason, /stale/);
  assert.equal(requestFor(controller, "L-2029")!.state, "pending");

  await controller.reducers.approvePayment({ requestId: req.id, snapshotDigest: req.snapshotDigest });
  assert.equal(lastLog(controller, "approve_payment").outcome, "ok");
  assert.equal(requestFor(controller, "L-2029")!.state, "approved");
  assert.equal(count(controller.db.approval), 1);

  // Whoever lost the L-2033 race is not the requester; the other eligible
  // persona approves it (the AP lead stays under the AP ceiling here).
  const raceReq = requestFor(ap_lead, "L-2033")!;
  const approver = raceReq.requestedBy === "A-ap" ? controller : ap_lead;
  await approver.reducers.approvePayment({ requestId: raceReq.id, snapshotDigest: raceReq.snapshotDigest });
  assert.equal(lastLog(approver, "approve_payment").outcome, "ok");
  assert.equal(requestFor(approver, "L-2033")!.state, "approved");
});

test("stale approval: a bank change before claim invalidates the approval and returns it to pending", async () => {
  const { controller, runner } = conns;
  const req = requestFor(controller, "L-2037")!;
  await controller.reducers.approvePayment({ requestId: req.id, snapshotDigest: req.snapshotDigest });
  assert.equal(requestFor(controller, "L-2037")!.state, "approved");
  await controller.reducers.updateCarrierBank({ carrierId: "C-204", bankLabel: "Changed Bank ••0001", pending: false });
  await sleep(100);
  await runner.reducers.claimPayment({ requestId: req.id, idempotencyKey: "key-L-2037-1" });
  assert.match(lastLog(runner, "claim_payment").reason, /Snapshot changed/);
  const back = requestFor(runner, "L-2037")!;
  assert.equal(back.state, "pending");
  assert.equal(back.idempotencyKey, "");
});

test("runner: claim freezes the payload; outcomes are idempotent and transitions are enforced", async () => {
  const { controller, runner, agent } = conns;
  const req = requestFor(controller, "L-2029")!;
  assert.equal(req.state, "approved");
  await agent.reducers.claimPayment({ requestId: req.id, idempotencyKey: "k" });
  assert.match(lastLog(agent, "claim_payment").reason, /Role agent may not/);

  await runner.reducers.claimPayment({ requestId: req.id, idempotencyKey: "key-L-2029-1" });
  const claimed = requestFor(runner, "L-2029")!;
  assert.equal(claimed.state, "submitting");
  assert.equal(claimed.idempotencyKey, "key-L-2029-1");
  const payload = JSON.parse(claimed.frozenPayload);
  assert.equal(payload.amount_cents, "310000");
  assert.equal(payload.payee.id, "C-452");

  await runner.reducers.recordPaymentOutcome({ requestId: req.id, idempotencyKey: "other", outcome: "submitted", transferId: "tr_1", detail: "" });
  assert.match(lastLog(runner, "record_payment_outcome").reason, /key does not match/);
  await runner.reducers.recordPaymentOutcome({ requestId: req.id, idempotencyKey: "key-L-2029-1", outcome: "simulated_settled", transferId: "tr_1", detail: "" });
  assert.match(lastLog(runner, "record_payment_outcome").reason, /not permitted/);
  await runner.reducers.recordPaymentOutcome({ requestId: req.id, idempotencyKey: "key-L-2029-1", outcome: "submitted", transferId: "tr_1", detail: "mock accepted" });
  assert.equal(requestFor(runner, "L-2029")!.state, "submitted");
  await runner.reducers.recordPaymentOutcome({ requestId: req.id, idempotencyKey: "key-L-2029-1", outcome: "submitted", transferId: "tr_1", detail: "dup" });
  assert.match(lastLog(runner, "record_payment_outcome").reason, /Duplicate/);
  await runner.reducers.recordPaymentOutcome({ requestId: req.id, idempotencyKey: "key-L-2029-1", outcome: "submitted", transferId: "tr_OTHER", detail: "" });
  assert.match(lastLog(runner, "record_payment_outcome").reason, /does not match recorded transfer/);
  await runner.reducers.recordPaymentOutcome({ requestId: req.id, idempotencyKey: "key-L-2029-1", outcome: "simulated_settled", transferId: "tr_1", detail: "mock settled" });
  assert.equal(requestFor(runner, "L-2029")!.state, "simulated_settled");
  assert.equal(requestFor(runner, "L-2029")!.transferId, "tr_1");
});

test("every refusal in this run is a committed decision_log row attributed to the real sender", async () => {
  const { controller } = conns;
  const refusals = logs(controller).filter(l => l.outcome === "refused");
  assert.ok(refusals.length >= 12, `expected many refusals, got ${refusals.length}`);
  const actors = new Set(refusals.map(l => l.actorId));
  assert.ok(actors.has("A-agent") && actors.has("A-ap"));
  for (const l of refusals) assert.notEqual(l.actorIdentity.toHexString(), "");
});
