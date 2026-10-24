import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Timestamp } from "spacetimedb";
import type { DbConnection } from "../bindings/index.ts";
import { connect, ensurePersona, sleep } from "./lib/connect.ts";
import { ANTHROPIC_API_KEY, CLAUDE_MODEL } from "./lib/env.ts";
import { ClaudeUnavailable, extractInvoice, explainDecision as claudeExplain, EXTRACT_PROMPT_VERSION } from "./lib/claude.ts";
import { manualExtractions } from "./lib/manual-extractions.ts";
import { explainDecision as templateExplain } from "./lib/explain.ts";
import { projectReview } from "./lib/project.ts";
import { evaluateSettlement } from "../module/rules.ts";
import type { Decision } from "../module/rules.ts";

// The agent process. It holds the `agent` identity, which the database lets
// read documents, record extractions, propose settlements and request
// payment. It cannot approve, claim or settle anything, and it cannot change
// a decision: the reducer recomputes policy from trusted rows every time.
//
//   npx tsx agent/worker.ts            process everything pending, exit
//   npx tsx agent/worker.ts --watch    keep running, react to new documents
//   npx tsx agent/worker.ts --manual   skip Claude even if a key is present
//   npx tsx agent/worker.ts --leave-ready=L-2033,L-2029
//                                      propose these loads but do not request them,
//                                      so the demo can request them live

const WATCH = process.argv.includes("--watch");
const FORCE_MANUAL = process.argv.includes("--manual");
const LEAVE_READY = new Set((process.argv.find(a => a.startsWith("--leave-ready="))?.slice("--leave-ready=".length) ?? "").split(",").filter(Boolean));
const useClaude = !!ANTHROPIC_API_KEY && !FORCE_MANUAL;

const money = (c: number | bigint) => `$${(Number(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const iso = (t: Timestamp) => new Date(Number(t.microsSinceUnixEpoch / 1000n)).toISOString();
const ts = (isoDate: string) => new Timestamp(BigInt(Date.parse(isoDate)) * 1000n);
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} [agent] ${line}`);

const agent = await connect("agent");
await ensurePersona(agent, "agent");
log(`online as agent · identity ${agent.identity!.toHexString().slice(0, 8)} · reader: ${useClaude ? `claude (${CLAUDE_MODEL}, ${EXTRACT_PROMPT_VERSION})` : "manual fallback (labeled; no model)"}`);
if (!useClaude && !FORCE_MANUAL) log("ANTHROPIC_API_KEY not set; every extraction is recorded with method=manual");

const extractionFor = (db: DbConnection["db"], documentId: string) => [...db.extraction.iter()].find(e => e.documentId === documentId);
const settlementFor = (db: DbConnection["db"], documentId: string) => [...db.settlement.iter()].find(s => s.invoiceDocumentId === documentId);

async function readInvoice(docId: string): Promise<boolean> {
  const db = agent.db;
  const doc = db.document.id.find(docId)!;
  const pdf = resolve("world/out", `${docId}.pdf`);
  if (useClaude && existsSync(pdf)) {
    try {
      const roster = {
        carriers: [...db.carrier.iter()].map(c => ({ id: c.id, name: c.name })),
        factors: [...db.factor.iter()].map(f => ({ id: f.id, name: f.name })),
      };
      const x = await extractInvoice(pdf, doc.contentHash, roster);
      await agent.reducers.recordExtraction({
        documentId: docId, contentHash: doc.contentHash, invoiceNumber: x.invoiceNumber, invoiceAt: ts(x.invoiceAt), currency: x.currency,
        linehaulCents: BigInt(x.linehaulCents), accessorialsCents: BigInt(x.accessorialsCents), totalCents: BigInt(x.totalCents),
        remitToKind: x.remitTo?.kind ?? "unknown", remitToId: x.remitTo?.id ?? "", confidence: x.confidence,
        model: x.model, promptVersion: x.promptVersion, method: "claude", explanation: x.explanation,
      });
      log(`${docId} read by ${x.model} · ${x.invoiceNumber} · ${money(x.totalCents)} · remit to "${x.remitToName}" → ${x.remitTo ? `${x.remitTo.kind} ${x.remitTo.id}` : "no roster match"} · confidence ${x.confidence.toFixed(2)}`);
      return true;
    } catch (e) {
      if (!(e instanceof ClaudeUnavailable)) throw e;
      log(`${docId} claude unavailable (${e.message.slice(0, 120)}); falling back to manual`);
    }
  }
  const m = manualExtractions.find(x => x.documentId === docId);
  if (!m) { log(`${docId} no reader available and no manual fixture; skipped`); return false; }
  await agent.reducers.recordExtraction({
    documentId: docId, contentHash: doc.contentHash, invoiceNumber: m.invoiceNumber, invoiceAt: ts(m.invoiceAt), currency: m.currency,
    linehaulCents: BigInt(m.linehaulCents), accessorialsCents: BigInt(m.accessorialsCents), totalCents: BigInt(m.totalCents),
    remitToKind: m.remitTo.kind, remitToId: m.remitTo.id, confidence: m.confidence,
    model: "none", promptVersion: "manual-1", method: "manual", explanation: "Manual extraction fallback: fields typed from the fixture, not read by a model.",
  });
  log(`${docId} typed from manual fixture · ${m.invoiceNumber} · ${money(m.totalCents)} · remit to ${m.remitTo.kind} ${m.remitTo.id}`);
  return true;
}

async function prose(loadId: string, docId: string, d: Decision) {
  const db = agent.db;
  if (!useClaude) return templateExplain(agent, loadId, docId, d);
  try {
    const load = db.load.id.find(loadId)!;
    const carrier = db.carrier.id.find(load.carrierId)!;
    const ex = extractionFor(db, docId)!;
    const assignment = [...db.assignment.iter()].find(a => a.carrierId === carrier.id && !a.releasedAt);
    const factor = assignment ? db.factor.id.find(assignment.factorId) : undefined;
    const remitRow = ex.remitToKind === "factor" ? db.factor.id.find(ex.remitToId) : db.carrier.id.find(ex.remitToId);
    const other = [...db.paymentRequest.iter()].find(r => r.loadId === loadId && r.invoiceDocumentId !== docId);
    return await claudeExplain({
      loadId, lane: load.lane, customer: load.customer, deliveredAt: load.deliveredAt ? iso(load.deliveredAt) : null, agreedCents: Number(load.rateCents),
      carrier: { id: carrier.id, name: carrier.name },
      factor: assignment && factor ? { id: factor.id, name: factor.name, contactEmail: factor.contactEmail, assignmentEffective: iso(assignment.effectiveAt), assignmentDocumentId: assignment.sourceDocumentId } : undefined,
      invoice: { documentId: docId, invoiceNumber: ex.invoiceNumber, totalCents: Number(ex.totalCents), remitToName: remitRow?.name ?? ex.remitToId, invoiceAt: iso(ex.invoiceAt) },
      documents: [...db.document.iter()].filter(x => x.carrierId === carrier.id && (!x.loadId || x.loadId === loadId)).map(x => ({ id: x.id, kind: x.kind, title: x.title, sender: x.sender })),
      existingObligation: other ? { requestId: String(other.id), invoiceNumber: other.invoiceKey.split("|")[1] ?? "", state: other.state } : undefined,
    }, d);
  } catch (e) {
    if (!(e instanceof ClaudeUnavailable)) throw e;
    log(`explanation: claude unavailable (${e.message.slice(0, 120)}); using template`);
    return templateExplain(agent, loadId, docId, d);
  }
}

async function settle(docId: string) {
  const db = agent.db;
  const doc = db.document.id.find(docId)!;
  const loadId = doc.loadId!;
  const input = projectReview(agent, loadId, docId);
  const local = input ? evaluateSettlement(input) : null;
  const text = local ? await prose(loadId, docId, local) : { explanation: "", escalationEmail: "" };
  await agent.reducers.proposeSettlement({ loadId, invoiceDocumentId: docId, explanation: text.explanation, escalationEmail: text.escalationEmail });
  const s = settlementFor(db, docId);
  if (!s) { log(`${loadId} ${docId}: database refused to record a settlement (see decision_log)`); return; }
  const failed = s.ruleResults.filter(r => !r.passed).map(r => r.ruleId);
  log(`${loadId} ${docId}: policy says ${s.decision}${failed.length ? ` (${failed.join(", ")})` : ""} · settlement #${s.id} written by the database`);
  if (local && local.decision !== s.decision) log(`${loadId}: local preview (${local.decision}) differed from the reducer (${s.decision}); the reducer is authoritative`);
  if (s.decision === "request_approval") {
    if (LEAVE_READY.has(loadId)) { log(`${loadId}: left ready, not requested (--leave-ready)`); return; }
    await agent.reducers.requestPayment({ loadId, invoiceDocumentId: docId });
    const r = [...db.paymentRequest.iter()].find(x => x.loadId === loadId);
    log(r ? `${loadId}: payment request #${r.id} reserved · ${money(r.amountCents)} to ${r.payeeKind} ${r.payeeId} · needs a different human to approve` : `${loadId}: request refused by the database (see decision_log)`);
  }
}

let running = false, again = false;
async function pass() {
  if (running) { again = true; return; }
  running = true;
  try {
    const db = agent.db;
    const invoices = [...db.document.iter()].filter(d => d.kind === "invoice" && d.contentHash !== "" && d.loadId)
      .sort((a, b) => Number(a.receivedAt.microsSinceUnixEpoch - b.receivedAt.microsSinceUnixEpoch));
    for (const d of invoices) if (!extractionFor(db, d.id)) await readInvoice(d.id);
    await sleep(50);
    for (const d of invoices) if (extractionFor(db, d.id) && !settlementFor(db, d.id)) await settle(d.id);
  } finally {
    running = false;
    if (again) { again = false; await pass(); }
  }
}

await pass();
if (!WATCH) { log("nothing left to read; exiting"); agent.disconnect(); process.exit(0); }
log("watching for new documents");
let timer: NodeJS.Timeout | undefined;
const schedule = () => { clearTimeout(timer); timer = setTimeout(() => pass().catch(e => log(`pass failed: ${String(e)}`)), 300); };
agent.db.document.onInsert(schedule); agent.db.document.onUpdate(schedule); agent.db.extraction.onInsert(schedule);
