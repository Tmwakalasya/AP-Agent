import { checkApproval, evaluateSettlement } from "../module/rules.ts";
import { cleanCase, duplicateCase, redirectCase } from "./fixtures.ts";

console.log("Remit-To offline policy demo — synthetic extracted records; no money moves.\n");
for (const scenario of [redirectCase(), cleanCase(), duplicateCase()]) {
  const result = evaluateSettlement(scenario.input);
  console.log(`${scenario.id}: ${result.decision}`);
  console.log(`  Policy payee: ${result.payee?.kind} ${result.payee?.id}; proposed amount: ${result.amount_cents} cents`);
  console.log(`  Evidence: ${result.evidence_ids.join(", ")}`);
  for (const rule of result.rule_results.filter(r => !r.passed)) console.log(`  ${rule.rule_id}: ${rule.reason}`);
  if (result.question) console.log(`  ${result.question}`);
  console.log();
}
const request = { requested_by: "A-ap", amount_cents: 240_000, status: "pending", snapshot_current: true };
for (const actor of [
  { id: "A-ap", role: "ap_lead" as const, approval_limit_cents: 500_000 },
  { id: "A-controller", role: "controller" as const, approval_limit_cents: Number.MAX_SAFE_INTEGER },
]) {
  const result = checkApproval({ actor, request });
  console.log(`${actor.id}: ${result.allowed ? "approval permitted" : "approval refused"} — ${result.reason}`);
}
