import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Timestamp } from "spacetimedb";
import { spawn } from "node:child_process";
import { connect, ensurePersona, sleep } from "./lib/connect.ts";
import { startMockProvider } from "./mock-provider.ts";
import { projectReview } from "./lib/project.ts";
import { evaluateSettlement } from "../module/rules.ts";
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
  if (count(world.db.load) === 0) await world.reducers.seedWorld({});
  assert.equal(count(world.db.load), 4);
  assert.equal(count(world.db.document), 15);
  assert.equal(count(world.db.assignment), 1);
  await world.reducers.seedWorld({});
  assert.match(lastLog(world, "seed_world").reason, /already seeded/);
  await agent.reducers.seedWorld({});
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

async function extract(c: DbConnection, documentId: string, invoiceNumber: string, cents: bigint, remitToKind: string, remitToId: string, invoiceAt: string, loadReference: string) {
  await c.reducers.recordExtraction({
    documentId, contentHash: hashFor(documentId), invoiceNumber, loadReference, invoiceAt: ts(invoiceAt), currency: "USD",
    linehaulCents: cents, accessorialsCents: 0n, totalCents: cents, remitToKind, remitToId, confidence: 0.98,
    model: "test", promptVersion: "test", method: "manual", explanation: "test fixture",
  });
}

type ExtractionArgs = Parameters<DbConnection["reducers"]["recordExtraction"]>[0];
function extractionArgs(c: DbConnection, documentId: string): ExtractionArgs {
  const x = [...c.db.extraction.iter()].find(e => e.documentId === documentId)!;
  return {
    documentId, contentHash: x.contentHash, invoiceNumber: x.invoiceNumber, loadReference: x.loadReference,
    invoiceAt: x.invoiceAt, currency: x.currency, linehaulCents: x.linehaulCents,
    accessorialsCents: x.accessorialsCents, totalCents: x.totalCents,
    remitToKind: x.remitToKind, remitToId: x.remitToId, confidence: x.confidence,
    model: x.model, promptVersion: x.promptVersion, method: x.method, explanation: x.explanation,
  };
}

test("only the agent records extractions, and only against the received hash", async () => {
  const { agent, ap_lead } = conns;
  await ap_lead.reducers.recordExtraction({
    documentId: "D-inv-5521", contentHash: hashFor("D-inv-5521"), invoiceNumber: "X", loadReference: "L-2037", invoiceAt: ts("2026-06-10T13:00:00Z"), currency: "USD",
    linehaulCents: 1n, accessorialsCents: 0n, totalCents: 1n, remitToKind: "carrier", remitToId: "C-204", confidence: 1,
    model: "t", promptVersion: "t", method: "manual", explanation: "",
  });
  assert.match(lastLog(ap_lead, "record_extraction").reason, /Role ap_lead may not/);
  await agent.reducers.recordExtraction({
    documentId: "D-inv-5521", contentHash: "wrong", invoiceNumber: "X", loadReference: "L-2037", invoiceAt: ts("2026-06-10T13:00:00Z"), currency: "USD",
    linehaulCents: 1n, accessorialsCents: 0n, totalCents: 1n, remitToKind: "carrier", remitToId: "C-204", confidence: 1,
    model: "t", promptVersion: "t", method: "manual", explanation: "",
  });
  assert.match(lastLog(agent, "record_extraction").reason, /hash does not match/);
  assert.equal(count(agent.db.extraction), 0);

  await extract(agent, "D-inv-0612", "INV-88213", 240_000n, "carrier", "C-301", "2026-06-12T09:00:00Z", "L-2041");
  await extract(agent, "D-inv-5521", "INV-5521", 185_000n, "carrier", "C-204", "2026-06-10T13:30:00Z", "L-2037");
  await extract(agent, "D-inv-5521R", "INV-5521-R", 185_000n, "carrier", "C-204", "2026-06-24T08:00:00Z", "L-2037");
  await extract(agent, "D-inv-7710", "INV-7710", 92_500n, "carrier", "C-118", "2026-06-09T11:00:00Z", "L-2033");
  await extract(agent, "D-inv-3302", "INV-3302", 310_000n, "carrier", "C-452", "2026-06-12T15:00:00Z", "L-2029");
  assert.equal(count(agent.db.extraction), 5);
});

test("invoice matching: wrong or missing extracted load references hold despite the seeded document association", async () => {
  const { agent } = conns;
  const original = extractionArgs(agent, "D-inv-5521");
  for (const loadReference of ["L-2029", ""]) {
    await agent.reducers.recordExtraction({ ...original, loadReference });
    const preview = projectReview(agent, "L-2037", original.documentId)!;
    assert.equal(preview.invoice.load_id, loadReference);
    assert.equal(evaluateSettlement(preview).decision, "hold");
    await agent.reducers.proposeSettlement({ loadId: "L-2037", invoiceDocumentId: original.documentId, explanation: "", escalationEmail: "" });
    assert.ok(lastLog(agent, "propose_settlement").ruleResults.some(r => r.ruleId === "R7" && !r.passed));
    await agent.reducers.requestPayment({ loadId: "L-2037", invoiceDocumentId: original.documentId });
    assert.equal(lastLog(agent, "request_payment").outcome, "refused");
    assert.equal(requestFor(agent, "L-2037"), undefined);
  }
  await agent.reducers.recordExtraction(original);
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

test("extraction corrections invalidate approval even when the agreed amount and policy verdict stay unchanged", async () => {
  const { agent, controller, runner } = conns;
  const original = extractionArgs(agent, "D-inv-5521");
  const req = requestFor(controller, "L-2037")!;

  // A correction before approval changes the snapshot seen by the approver.
  await agent.reducers.recordExtraction({ ...original, linehaulCents: 185_050n, totalCents: 185_050n });
  let current = requestFor(agent, "L-2037")!;
  assert.equal(current.amountCents, req.amountCents);
  assert.notEqual(current.snapshotDigest, req.snapshotDigest);
  await controller.reducers.approvePayment({ requestId: req.id, snapshotDigest: req.snapshotDigest });
  assert.equal(lastLog(controller, "approve_payment").outcome, "refused");
  await controller.reducers.approvePayment({ requestId: req.id, snapshotDigest: current.snapshotDigest });
  assert.equal(requestFor(controller, "L-2037")!.state, "approved");

  // Display-only prose may change without invalidating unchanged facts.
  await agent.reducers.recordExtraction({ ...extractionArgs(agent, original.documentId), explanation: "Reworded note" });
  assert.equal(requestFor(agent, "L-2037")!.state, "approved");

  // A correction after approval must prevent dispatch and require another approval.
  const approvedDigest = current.snapshotDigest;
  await agent.reducers.recordExtraction(original);
  current = requestFor(agent, "L-2037")!;
  assert.equal(current.state, "pending");
  assert.notEqual(current.snapshotDigest, approvedDigest);
  await runner.reducers.claimPayment({ requestId: req.id, idempotencyKey: "stale-extraction" });
  assert.equal(lastLog(runner, "claim_payment").outcome, "refused");
  assert.equal(requestFor(runner, "L-2037")!.idempotencyKey, "");
  await controller.reducers.approvePayment({ requestId: req.id, snapshotDigest: approvedDigest });
  assert.equal(lastLog(controller, "approve_payment").outcome, "refused");
  await controller.reducers.approvePayment({ requestId: req.id, snapshotDigest: current.snapshotDigest });
  assert.equal(requestFor(controller, "L-2037")!.state, "approved");

  // Changing the invoice identity must not silently move its unique reservation.
  await agent.reducers.recordExtraction({ ...original, invoiceNumber: "CORRECTED-INVOICE-999" });
  current = requestFor(agent, "L-2037")!;
  assert.equal(current.state, "pending");
  assert.equal(current.invoiceKey, req.invoiceKey);
  assert.match(current.lastOutcome, /invoice identity changed.*Original reservation retained/);
  await controller.reducers.approvePayment({ requestId: req.id, snapshotDigest: current.snapshotDigest });
  assert.equal(lastLog(controller, "approve_payment").outcome, "refused");
  await runner.reducers.claimPayment({ requestId: req.id, idempotencyKey: "changed-invoice" });
  assert.equal(lastLog(runner, "claim_payment").outcome, "refused");
  assert.equal(requestFor(runner, "L-2037")!.frozenPayload, "");
  await agent.reducers.recordExtraction(original);
});

test("stale approval: a bank change before dispatch voids the approval; the re-bound request can be approved again", async () => {
  const { controller, runner } = conns;
  const req = requestFor(controller, "L-2037")!;
  await controller.reducers.approvePayment({ requestId: req.id, snapshotDigest: req.snapshotDigest });
  assert.equal(requestFor(controller, "L-2037")!.state, "approved");

  // The bank change itself sends the request back to pending, bound to the new destination.
  await controller.reducers.updateCarrierBank({ carrierId: "C-204", bankLabel: "Changed Bank ••0001", pending: false });
  await sleep(100);
  const back = requestFor(controller, "L-2037")!;
  assert.equal(back.state, "pending");
  assert.equal(back.bankVersion, req.bankVersion + 1);
  assert.notEqual(back.snapshotDigest, req.snapshotDigest);
  assert.match(back.lastOutcome, /invalidated/);
  assert.equal(back.idempotencyKey, "");

  // The old approval cannot dispatch, and the old digest cannot approve.
  await runner.reducers.claimPayment({ requestId: req.id, idempotencyKey: "key-L-2037-1" });
  assert.match(lastLog(runner, "claim_payment").reason, /not approved/);
  await controller.reducers.approvePayment({ requestId: req.id, snapshotDigest: req.snapshotDigest });
  assert.match(lastLog(controller, "approve_payment").reason, /stale/);
  assert.equal(requestFor(controller, "L-2037")!.state, "pending");

  // The re-bound snapshot takes a new approval; a second change voids it again.
  await controller.reducers.approvePayment({ requestId: req.id, snapshotDigest: back.snapshotDigest });
  assert.equal(lastLog(controller, "approve_payment").outcome, "ok");
  assert.equal(requestFor(controller, "L-2037")!.state, "approved");
  await controller.reducers.updateCarrierBank({ carrierId: "C-204", bankLabel: "Changed Bank ••0002", pending: false });
  await sleep(100);
  const again = requestFor(controller, "L-2037")!;
  assert.equal(again.state, "pending");
  assert.equal(again.bankVersion, req.bankVersion + 2);

  // A pending bank change is a policy hold (R8): the request stays pending and no digest can approve it.
  await controller.reducers.updateCarrierBank({ carrierId: "C-204", bankLabel: "Changed Bank ••0003", pending: true });
  await sleep(100);
  const held = requestFor(controller, "L-2037")!;
  assert.equal(held.state, "pending");
  assert.match(held.lastOutcome, /holds this invoice \(R8\)/);
  await controller.reducers.approvePayment({ requestId: req.id, snapshotDigest: held.snapshotDigest });
  assert.match(lastLog(controller, "approve_payment").reason, /Policy now holds/);
  assert.equal(requestFor(controller, "L-2037")!.state, "pending");
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

test("provider transfer ids cannot be reused for another obligation; refusal preserves its state", async () => {
  const { agent, controller, runner } = conns;
  const paid = requestFor(runner, "L-2029")!;
  assert.equal(paid.state, "simulated_settled");
  await controller.reducers.updateCarrierBank({ carrierId: "C-204", bankLabel: "Verified bank", pending: false });
  const req = requestFor(controller, "L-2037")!;
  await controller.reducers.approvePayment({ requestId: req.id, snapshotDigest: req.snapshotDigest });
  await runner.reducers.claimPayment({ requestId: req.id, idempotencyKey: "transfer-reuse-test" });
  const before = requestFor(runner, "L-2037")!;
  assert.equal(before.state, "submitting");
  await runner.reducers.recordPaymentOutcome({ requestId: req.id, idempotencyKey: before.idempotencyKey, outcome: "submitted", transferId: paid.transferId, detail: "wrong obligation" });
  assert.equal(lastLog(runner, "record_payment_outcome").outcome, "refused");
  assert.match(lastLog(runner, "record_payment_outcome").reason, /already belongs to request/);
  assert.deepEqual(requestFor(runner, "L-2037"), before);
  assert.equal([...runner.db.paymentRequest.iter()].filter(r => r.transferId === paid.transferId).length, 1);

  // Independent transfer succeeds, and repeating its notification is still safe.
  const outcome = { requestId: req.id, idempotencyKey: before.idempotencyKey, outcome: "submitted", transferId: "tr_independent", detail: "mock accepted" };
  await runner.reducers.recordPaymentOutcome(outcome);
  await runner.reducers.recordPaymentOutcome(outcome);
  assert.match(lastLog(runner, "record_payment_outcome").reason, /Duplicate submitted/);
  await runner.reducers.recordPaymentOutcome({ ...outcome, outcome: "simulated_settled" });
  assert.equal(requestFor(runner, "L-2037")!.state, "simulated_settled");

  // Post-dispatch corrections cannot reset the frozen payment or permit another claim.
  await agent.reducers.recordExtraction({ ...extractionArgs(agent, req.invoiceDocumentId), invoiceNumber: "LATE-CORRECTION" });
  assert.equal(requestFor(agent, "L-2037")!.state, "simulated_settled");
  assert.equal(requestFor(agent, "L-2037")!.frozenPayload, before.frozenPayload);
});

test("crash after accept: a restarted runner reconciles by the stored key; one transfer, one submitted event", async () => {
  const { controller } = conns;
  const provider = await startMockProvider({ port: 0, latencyMs: 0, settleAfterMs: 500, stateFile: null });
  // Async spawn: the mock provider lives in this process and must keep serving while the runner runs.
  const run = (...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>(done => {
    const child = spawn(process.execPath, ["--import", "tsx", "agent/runner.ts", "--once", ...args], { env: { ...process.env, PROVIDER_URL: provider.url } });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => stdout += d); child.stderr.on("data", d => stderr += d);
    child.on("close", status => done({ status, stdout, stderr }));
  });
  try {
    const req = requestFor(controller, "L-2033")!;
    assert.equal(req.state, "approved");

    // Run 1: the provider accepts; the process dies before recording the outcome.
    const crashed = await run("--crash-after-accept");
    assert.equal(crashed.status, 137, crashed.stdout + crashed.stderr);
    await sleep(200);
    const mid = requestFor(controller, "L-2033")!;
    assert.equal(mid.state, "submitting");
    assert.ok(mid.idempotencyKey.startsWith("rt-"));
    assert.equal(provider.transfers().length, 1);
    assert.equal(mid.frozenPayload, provider.transfers()[0].payload);

    // Run 2: a fresh process asks the provider about the stored key first.
    const restarted = await run();
    assert.equal(restarted.status, 0, restarted.stdout + restarted.stderr);
    assert.match(restarted.stdout, /already holds .* for that key/);
    await sleep(200);
    const after = requestFor(controller, "L-2033")!;
    assert.equal(after.state, "submitted");
    assert.equal(after.transferId, provider.transfers()[0].transfer_id);
    assert.equal(provider.transfers().length, 1);
    const submittedEvents = logs(controller, "record_payment_outcome").filter(l => l.requestId === req.id && / submitting → submitted/.test(l.reason));
    assert.equal(submittedEvents.length, 1);

    // Run 3: after the mock's settle delay the obligation reaches its labeled terminal state.
    await sleep(600);
    const settled = await run();
    assert.equal(settled.status, 0, settled.stdout + settled.stderr);
    await sleep(200);
    assert.equal(requestFor(controller, "L-2033")!.state, "simulated_settled");
    assert.equal(provider.transfers().length, 1);
  } finally {
    await provider.close();
  }
});
test("every refusal in this run is a committed decision_log row attributed to the real sender", async () => {
  const { controller } = conns;
  const refusals = logs(controller).filter(l => l.outcome === "refused");
  assert.ok(refusals.length >= 12, `expected many refusals, got ${refusals.length}`);
  const actors = new Set(refusals.map(l => l.actorId));
  assert.ok(actors.has("A-agent") && actors.has("A-ap"));
  for (const l of refusals) assert.notEqual(l.actorIdentity.toHexString(), "");
});
