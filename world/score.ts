import { readFileSync } from "node:fs";
import { evaluateSettlement } from "../module/rules.ts";
import { developmentCases } from "./fixtures.ts";
import { scoreDecisions } from "./scoring.ts";
import type { Expected } from "./scoring.ts";

const expected: Expected[] = JSON.parse(readFileSync(new URL("./answer-key.json", import.meta.url), "utf8"));
const observed = developmentCases().map(scenario => ({ case_id: scenario.id, result: evaluateSettlement(scenario.input) }));
const score = scoreDecisions(expected, observed);
console.log("Synthetic development fixtures; no extraction, durable storage or payment-provider validation.");
console.table(score.rows);
console.log(`${score.correct}/${score.cases} exact expected decisions. No money moved.`);
if (score.mismatches.length) {
  console.error("Mismatches:", score.mismatches.join(", "));
  process.exitCode = 1;
}
