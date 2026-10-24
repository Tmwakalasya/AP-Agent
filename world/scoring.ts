import type { Decision, Payee, RuleId } from "../module/rules.ts";

export type Expected = {
  case_id: string;
  category: "clean" | "duplicate" | "redirect";
  decision: Decision["decision"];
  amount_cents: number;
  payee: Payee;
  failed_rule: RuleId | null;
};
export type Observed = { case_id: string; result: Decision };

export function scoreDecisions(expected: Expected[], observed: Observed[]) {
  const expectedIds = new Set(expected.map(e => e.case_id));
  const observedIds = new Set(observed.map(o => o.case_id));
  if (expectedIds.size !== expected.length || observedIds.size !== observed.length ||
      expected.length !== observed.length || observed.some(o => !expectedIds.has(o.case_id))) {
    throw new Error("Every case needs exactly one expectation and one observed result; no implicit clean cases.");
  }
  const actual = new Map(observed.map(o => [o.case_id, o.result]));
  const rows = (["clean", "duplicate", "redirect"] as const).map(category => {
    const cases = expected.filter(e => e.category === category);
    return { category, cases: cases.length, correct: 0, false_holds: 0, unsafe_requests: 0 };
  });
  const mismatches: string[] = [];
  for (const e of expected) {
    const result = actual.get(e.case_id)!;
    const row = rows.find(r => r.category === e.category)!;
    const payeeMatches = result.payee?.kind === e.payee.kind && result.payee?.id === e.payee.id;
    const amountMatches = result.amount_cents === e.amount_cents;
    const ruleMatches = e.failed_rule === null ? result.rule_results.every(r => r.passed) :
      result.rule_results.some(r => r.rule_id === e.failed_rule && !r.passed);
    const correct = result.decision === e.decision && payeeMatches && amountMatches && ruleMatches;
    if (correct) row.correct++;
    else mismatches.push(e.case_id);
    if (e.decision === "request_approval" && result.decision === "hold") row.false_holds++;
    if (result.decision === "request_approval" &&
        (e.decision === "hold" || !payeeMatches || !amountMatches || !ruleMatches)) row.unsafe_requests++;
  }
  return { cases: expected.length, correct: expected.length - mismatches.length, rows, mismatches };
}
