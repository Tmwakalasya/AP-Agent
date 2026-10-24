import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Timestamp } from "spacetimedb";
import { connect, ensurePersona, sleep } from "./lib/connect.ts";
import { manualExtractions } from "./lib/manual-extractions.ts";
import { explainDecision } from "./lib/explain.ts";
import { evaluateSettlement } from "../module/rules.ts";
import { projectReview } from "./lib/project.ts";

// Seeds the world as the `world` persona, then reads every invoice as the
// `agent` persona using the labeled manual-extraction fallback. The AP lead
// and controller personas are left unbound for the browser tabs.

const world = await connect("world");
await ensurePersona(world, "world");
if (Number(world.db.load.count()) === 0) { await world.reducers.seedWorld(); console.log("seeded world"); }

// Attach the hash of each rendered file when it exists; otherwise a labeled
// placeholder hash so the extraction/evidence chain still has a value to match.
for (const d of world.db.document.iter()) {
  if (d.contentHash !== "") continue;
  const file = `world/out/${d.id}.pdf`;
  const hash = existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : `placeholder-${d.id}`;
  await world.reducers.attachDocumentFile({ documentId: d.id, contentHash: hash, path: existsSync(file) ? `docs/${d.id}.pdf` : "" });
}
console.log("attached document hashes");

const agent = await connect("agent");
await ensurePersona(agent, "agent");
for (const ex of manualExtractions) {
  const doc = agent.db.document.id.find(ex.documentId);
  if (!doc) continue;
  if (agent.db.extraction.documentId.find(ex.documentId)) continue;
  await agent.reducers.recordExtraction({
    documentId: ex.documentId, contentHash: doc.contentHash, invoiceNumber: ex.invoiceNumber,
    invoiceAt: new Timestamp(BigInt(Date.parse(ex.invoiceAt)) * 1000n), currency: ex.currency,
    linehaulCents: BigInt(ex.linehaulCents), accessorialsCents: BigInt(ex.accessorialsCents), totalCents: BigInt(ex.totalCents),
    remitToKind: ex.remitTo.kind, remitToId: ex.remitTo.id, confidence: ex.confidence,
    model: "none", promptVersion: "manual-1", method: "manual", explanation: "Manual extraction fallback: fields typed from the fixture, not read by a model.",
  });
}
await sleep(100);
console.log("recorded extractions");

for (const ex of manualExtractions) {
  const doc = agent.db.document.id.find(ex.documentId);
  if (!doc?.loadId) continue;
  const already = [...agent.db.settlement.iter()].some(s => s.invoiceDocumentId === ex.documentId);
  if (already) continue;
  // The agent computes the same decision locally to write prose; the reducer
  // recomputes it from trusted rows and that result is the one stored.
  const input = projectReview(agent, doc.loadId, ex.documentId);
  const decision = input ? evaluateSettlement(input) : null;
  const prose = decision ? explainDecision(agent, doc.loadId, ex.documentId, decision) : { explanation: "", escalationEmail: "" };
  await agent.reducers.proposeSettlement({ loadId: doc.loadId, invoiceDocumentId: ex.documentId, explanation: prose.explanation, escalationEmail: prose.escalationEmail });
  if (decision?.decision === "request_approval") {
    await agent.reducers.requestPayment({ loadId: doc.loadId, invoiceDocumentId: ex.documentId });
  }
  const s = [...agent.db.settlement.iter()].filter(x => x.invoiceDocumentId === ex.documentId).at(-1);
  console.log(`${doc.loadId} ${ex.documentId}: ${s?.decision} ${s?.ruleResults.filter(r => !r.passed).map(r => r.ruleId).join(",")}`);
}
world.disconnect(); agent.disconnect();
