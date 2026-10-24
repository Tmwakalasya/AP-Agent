import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateSettlement } from "../module/rules.ts";
import { cleanCase, developmentCases, redirectCase } from "./fixtures.ts";
import { scoreDecisions } from "./scoring.ts";
import type { Expected } from "./scoring.ts";

const expected: Expected[] = JSON.parse(readFileSync(new URL("./answer-key.json", import.meta.url), "utf8"));

test("the full synthetic suite agrees with explicit expectations for every case", () => {
  const observed = developmentCases().map(s => ({ case_id: s.id, result: evaluateSettlement(s.input) }));
  const result = scoreDecisions(expected, observed);
  assert.equal(result.cases, 36);
  assert.equal(result.correct, 36);
  assert.deepEqual(result.mismatches, []);
});

test("scoring rejects a missing, extra or repeated case instead of assuming it is clean", () => {
  const scenario = cleanCase();
  const actual = { case_id: scenario.id, result: evaluateSettlement(scenario.input) };
  const key = expected.filter(e => e.case_id === scenario.id);
  assert.throws(() => scoreDecisions(key, []));
  assert.throws(() => scoreDecisions([], [actual]));
  assert.throws(() => scoreDecisions(key, [actual, actual]));
  assert.throws(() => scoreDecisions([key[0], key[0]], [actual]));
});

test("scoring detects a wrong payee, false hold and unsafe redirect request", () => {
  const clean = cleanCase(); const redirect = redirectCase();
  const cleanKey = expected.filter(e => e.case_id === clean.id);
  const redirectKey = expected.filter(e => e.case_id === redirect.id);
  const wrongPayee = evaluateSettlement(clean.input);
  wrongPayee.payee = { kind: "factor", id: "F-wrong" };
  const wrongScore = scoreDecisions(cleanKey, [{ case_id: clean.id, result: wrongPayee }]);
  assert.equal(wrongScore.correct, 0); assert.equal(wrongScore.rows[0].unsafe_requests, 1);
  const falseHold = evaluateSettlement(clean.input); falseHold.decision = "hold";
  const heldScore = scoreDecisions(cleanKey, [{ case_id: clean.id, result: falseHold }]);
  assert.equal(heldScore.rows[0].false_holds, 1);
  const unsafe = evaluateSettlement(redirect.input); unsafe.decision = "request_approval";
  const unsafeScore = scoreDecisions(redirectKey, [{ case_id: redirect.id, result: unsafe }]);
  assert.equal(unsafeScore.correct, 0); assert.equal(unsafeScore.rows[2].unsafe_requests, 1);
});
