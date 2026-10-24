import assert from "node:assert/strict";
import test from "node:test";
import { checkApproval, evaluateSettlement } from "./rules.ts";
import type { ReviewInput, RuleId } from "./rules.ts";
import { cleanCase, duplicateCase, redirectCase } from "../world/fixtures.ts";

function assertHeld(input: ReviewInput, rule: RuleId) {
  const result = evaluateSettlement(input);
  assert.equal(result.decision, "hold");
  assert.ok(result.rule_results.some(r => r.rule_id === rule && !r.passed));
  assert.ok(result.question);
  return result;
}

test("clean invoice prepares the agreed amount for approval without mutating its inputs", () => {
  const { input } = cleanCase();
  const before = structuredClone(input);
  const result = evaluateSettlement(input);
  assert.equal(result.decision, "request_approval");
  assert.equal(result.amount_cents, 240_000);
  assert.deepEqual(result.payee, { kind: "carrier", id: "C-001" });
  assert.deepEqual(result.evidence_ids.sort(), ["D-invoice-001", "D-pod-001", "D-rate-001"]);
  assert.deepEqual(input, before);
});

test("the June redirect stays held against the March assignment and cites the NOA", () => {
  const { input } = redirectCase();
  const result = assertHeld(input, "R2");
  assert.deepEqual(result.payee, { kind: "factor", id: "F-01" });
  assert.ok(result.evidence_ids.includes("D-noa-31"));
  assert.match(result.question!, /Factor F-01/);
});

test("a clean factored invoice can proceed to approval for the factor", () => {
  const { input } = redirectCase();
  input.invoice.remit_to = { kind: "factor", id: "F-01" };
  assert.equal(evaluateSettlement(input).decision, "request_approval");
});

test("a second invoice for a reserved load is held even under a new invoice number", () => {
  assertHeld(duplicateCase().input, "R3");
});

test("changing the requested payee does not bypass a reserved obligation", () => {
  const { input } = redirectCase();
  input.invoice.remit_to = { kind: "factor", id: "F-01" };
  input.reservations.push({ load_id: input.load.id, carrier_id: input.carrier.id, invoice_number: "OLD-CARRIER-INVOICE" });
  assertHeld(input, "R3");
});

test("the carrier/invoice reservation catches a duplicate relabeled as another load", () => {
  const { input } = cleanCase();
  input.reservations.push({ load_id: "L-other", carrier_id: input.carrier.id, invoice_number: "  inv-001  " });
  assertHeld(input, "R3");
});

test("the same invoice number from another carrier does not cause a false hold", () => {
  const { input } = cleanCase();
  input.reservations.push({ load_id: "L-other", carrier_id: "C-other", invoice_number: input.invoice.invoice_number });
  assert.equal(evaluateSettlement(input).decision, "request_approval");
});

test("an assignment effective after the invoice does not change its payee", () => {
  const { input } = redirectCase();
  input.assignments[0].effective_at = "2026-06-11T09:00:00Z";
  assert.equal(evaluateSettlement(input).decision, "request_approval");
});

test("assignment ambiguity and unsupported releases are held instead of guessed", () => {
  const conflicting = redirectCase().input;
  conflicting.assignments.push({ ...conflicting.assignments[0], factor_id: "F-02" });
  assert.equal(assertHeld(conflicting, "R2").payee, null);
  const released = redirectCase().input;
  released.assignments[0].released_at = "2026-06-05T09:00:00Z";
  assert.equal(assertHeld(released, "R2").payee, null);
});

test("unknown, wrong-carrier and not-yet-received assignment evidence is held", () => {
  for (const mutate of [
    (input: ReviewInput) => { input.assignments[0].source_document_id = "D-invented"; },
    (input: ReviewInput) => { input.documents.at(-1)!.carrier_id = "C-other"; },
    (input: ReviewInput) => { input.documents.at(-1)!.received_at = "2026-06-11T09:00:00Z"; },
  ]) {
    const { input } = redirectCase(); mutate(input); assertHeld(input, "R2");
  }
});

test("an invalid assignment date cannot silently restore the carrier as payee", () => {
  const { input } = redirectCase();
  input.assignments[0].effective_at = "2026-02-30T09:00:00Z";
  assert.equal(assertHeld(input, "R2").payee, null);
});

test("missing or wrong-load POD and undelivered loads are held", () => {
  for (const mutate of [
    (input: ReviewInput) => { input.load.pod_document_id = null; },
    (input: ReviewInput) => { input.documents[1].load_id = "L-other"; },
    (input: ReviewInput) => { input.load.delivered = false; },
  ]) {
    const { input } = cleanCase(); mutate(input); assertHeld(input, "R6");
  }
});

test("high model confidence cannot override conflicting carrier identifiers", () => {
  const { input } = cleanCase(); input.invoice.confidence = 1;
  input.invoice.carrier_id = "C-other";
  assertHeld(input, "R7");
});

test("the tolerance boundary uses the agreed rate and holds mismatches above it", () => {
  for (const difference of [-100, 100]) {
    const { input } = cleanCase();
    input.invoice.linehaul_cents += difference; input.invoice.total_cents += difference;
    const result = evaluateSettlement(input);
    assert.equal(result.decision, "request_approval");
    assert.equal(result.amount_cents, 240_000);
  }
  const { input } = cleanCase();
  input.invoice.linehaul_cents += 101; input.invoice.total_cents += 101;
  assertHeld(input, "R1");
});

test("unsupported or malformed invoice facts fail closed", () => {
  const mutations = [
    (input: ReviewInput) => { input.invoice.currency = "CAD"; },
    (input: ReviewInput) => { input.invoice.accessorials_cents = 6000; input.invoice.total_cents += 6000; },
    (input: ReviewInput) => { input.invoice.confidence = 0.8; },
    (input: ReviewInput) => { input.invoice.confidence = NaN; },
    (input: ReviewInput) => { input.invoice.total_cents++; },
    (input: ReviewInput) => { input.invoice.linehaul_cents = -1; },
    (input: ReviewInput) => { input.invoice.total_cents = 240_000.5; },
    (input: ReviewInput) => { input.load.rate_cents = Number.MAX_SAFE_INTEGER + 1; },
    (input: ReviewInput) => { input.invoice.invoice_number = " "; },
    (input: ReviewInput) => { input.invoice.invoice_at = "2026-02-30T09:00:00Z"; },
    (input: ReviewInput) => { input.invoice.invoice_at = "2026-06-11T09:00:00Z"; },
    (input: ReviewInput) => { input.as_of = "invalid"; },
    (input: ReviewInput) => { input.documents.push({ ...input.documents[0] }); },
  ];
  for (const mutate of mutations) {
    const { input } = cleanCase(); mutate(input); assertHeld(input, "R10");
  }
});

test("unresolved bank changes and revoked authority are held", () => {
  const bank = cleanCase().input; bank.bank_change_pending = true; assertHeld(bank, "R8");
  const revoked = cleanCase().input; revoked.carrier.authority = "revoked"; assertHeld(revoked, "R9");
});

const ap = { id: "A-ap", role: "ap_lead" as const, approval_limit_cents: 500_000 };
const controller = { id: "A-controller", role: "controller" as const, approval_limit_cents: Number.MAX_SAFE_INTEGER };
const request = { requested_by: "A-agent", amount_cents: 240_000, status: "pending", snapshot_current: true };

test("AP self-approval is refused while a different controller may approve", () => {
  const ownRequest = { ...request, requested_by: ap.id };
  assert.equal(checkApproval({ actor: ap, request: ownRequest }).allowed, false);
  assert.equal(checkApproval({ actor: controller, request: ownRequest }).allowed, true);
  assert.equal(checkApproval({ actor: controller, request }).allowed, true);
});

test("the agent cannot approve; AP limits apply at the exact cent boundary", () => {
  assert.equal(checkApproval({ actor: { ...controller, role: "agent" }, request }).allowed, false);
  assert.equal(checkApproval({ actor: ap, request: { ...request, amount_cents: 500_000 } }).allowed, true);
  assert.equal(checkApproval({ actor: ap, request: { ...request, amount_cents: 500_001 } }).allowed, false);
  assert.equal(checkApproval({ actor: { ...ap, approval_limit_cents: 999_999 }, request: { ...request, amount_cents: 500_001 } }).allowed, false);
});

test("stale, non-pending or invalid requests cannot be approved", () => {
  for (const change of [
    { snapshot_current: false }, { status: "approved" }, { status: "submitted" },
    { amount_cents: 0 }, { amount_cents: -1 }, { amount_cents: 0.5 }, { amount_cents: NaN },
  ]) assert.equal(checkApproval({ actor: controller, request: { ...request, ...change } }).allowed, false);
});
