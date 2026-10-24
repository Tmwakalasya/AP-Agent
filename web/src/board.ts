import type { Session } from "./stdb.ts";
import { DB, DEFAULT_TARGET, DEMO, HOST, loadFromUrl, myActor, rememberLoad } from "./stdb.ts";
import { auditFor, documentsFor, items, lastActionBy, money, shortDate, clock, STATUS_LABEL } from "./model.ts";
import type { Item, Status } from "./model.ts";
import { checkApproval, RULE_LABELS } from "../../module/rules.ts";
import type { RuleId } from "../../module/rules.ts";

export type BoardOptions = { compact?: boolean; readOnly?: boolean };
type Notice = { title?: string; text: string; kind: "ok" | "refused" };

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const badgeClass = (s: Status) => ({
  hold: "hold", unknown: "hold", failed: "dim", rejected: "dim", awaiting_agent: "dim", ready: "ready",
  pending: "pending", approved: "ok", submitting: "sub", submitted: "sub", simulated_settled: "settled",
} as Record<Status, string>)[s];

// Display order puts the two fraud/duplicate checks first.
const CHECKS = (["R2", "R3", "R1", "R6", "R7", "R8", "R9", "R10"] as RuleId[]).map(id => ({ id, label: RULE_LABELS[id] }));
const extractionFor = (db: Session["conn"]["db"], documentId: string | null | undefined) =>
  documentId ? [...db.extraction.iter()].find(e => e.documentId === documentId) : undefined;
const STEPS: Array<[string, string]> = [["pending", "requested"], ["approved", "approved"], ["submitting", "claimed"], ["submitted", "submitted"], ["simulated_settled", "settled (mock)"]];

// The demo controls call agent/demo-control.ts (proxied by Vite), which acts
// as the agent through the same reducers. The board never holds that token.
class DemoControlError extends Error {}
type DemoOutcome = { outcome: string; reason: string; request_id: string | null };
type DemoResult = { error?: string; outcomes?: DemoOutcome[]; reserved?: number };
async function demoControl(path: string): Promise<DemoResult> {
  const down = "Demo control is not running. npm run demo:up starts it, or npm run demo:control on its own.";
  let res: Response;
  try { res = await fetch(`/demo-control/${path}`, { method: "POST" }); } catch { throw new DemoControlError(down); }
  const body = await res.json().catch(() => null) as DemoResult | null;
  if (!res.ok || !body) throw new DemoControlError(body?.error ?? down);
  return body;
}

export class Board {
  private selected: string | null = null;
  private prevStatus = new Map<string, Status>();
  private flashing = new Set<string>();
  private lastDetailKey = "";
  private busy = false;
  private notice: Notice | null = null;

  constructor(private root: HTMLElement, private session: Session, private opts: BoardOptions = {}) {
    root.classList.add("board");
    if (opts.compact) root.classList.add("compact");
    // The landing embed shares the page URL with the hero; only the full board follows ?load=.
    if (!opts.compact) this.selected = loadFromUrl();
    root.addEventListener("click", e => this.onClick(e));
    session.onChange(() => this.render());
    this.render();
  }

  // A full key (L-2037:D-inv-5521R) wins; a bare load id picks its primary invoice.
  private pick(list: Item[]): Item | undefined {
    if (this.selected) {
      const hit = list.find(i => i.key === this.selected) ?? list.find(i => i.loadId === this.selected && !i.rebill) ?? list.find(i => i.loadId === this.selected);
      if (hit) return hit;
    }
    return list.find(i => i.status === "hold") ?? list[0];
  }

  private select(key: string) {
    this.selected = key; this.notice = null;
    if (!this.opts.compact) { rememberLoad(key); this.root.dispatchEvent(new CustomEvent("remit-to:select", { detail: key, bubbles: true })); }
    this.render();
  }

  render() {
    const { session } = this;
    if (session.status !== "live") {
      this.root.innerHTML = session.status === "error"
        ? `<div class="b-empty"><b>Not connected.</b> ${esc(session.error)}<small>Expected SpacetimeDB at <code>${esc(HOST)}</code>, database <code>${esc(DB)}</code>. Start it with <code>spacetime start</code>, then <code>npm run reset</code>.</small></div>`
        : `<div class="b-empty">connecting to spacetimedb…</div>`;
      return;
    }
    const list = items(session.conn);
    const sel = this.pick(list);
    for (const i of list) {
      const prev = this.prevStatus.get(i.key);
      if (prev && prev !== i.status) { this.flashing.add(i.key); setTimeout(() => { this.flashing.delete(i.key); this.render(); }, 1200); }
      this.prevStatus.set(i.key, i.status);
    }
    const detailKey = sel ? `${sel.key}:${sel.settlement?.id ?? ""}:${sel.request?.state ?? ""}` : "";
    const animateDetail = detailKey !== this.lastDetailKey;
    this.lastDetailKey = detailKey;

    this.root.innerHTML = `
      <div class="b-col b-left">
        <div class="b-head"><span>Loads</span><span>${list.length}</span></div>
        ${list.length === 0 ? `<div class="b-muted">no loads yet${this.canSeed() ? " · seed the world →" : " · run <code>npm run seed</code>"}</div>` : ""}
        ${list.map(i => `
          <div class="load ${sel?.key === i.key ? "active" : ""} ${this.flashing.has(i.key) ? "flash" : ""}" data-key="${esc(i.key)}">
            <span class="load-id">${esc(i.loadId)}${i.rebill ? ` <em>re-bill</em>` : ""}<small>${esc(i.carrier?.name ?? "")} · ${money(i.load.rateCents)}</small></span>
            <span class="badge ${badgeClass(i.status)}">${esc(STATUS_LABEL[i.status])}</span>
          </div>`).join("")}
        <div class="b-head audit-head"><span>Audit</span><span>decision_log · live</span></div>
        <div class="audit">${auditFor(session.conn, undefined, this.opts.compact ? 6 : DEMO ? 14 : 12).map(l => `
          <div class="audit-row ${l.outcome}" title="${esc(l.reason)}"><span class="t">${clock(l.at)}</span> <span class="who">${esc(l.actorId.replace("A-", ""))}</span> ${esc(l.operation.replace(/_/g, " "))} ${l.loadId ? esc(l.loadId) : ""} <b>${esc(l.outcome)}</b>${DEMO && l.outcome === "refused" ? `<span class="why">${esc(l.reason)}</span>` : ""}</div>`).join("")}
        </div>
      </div>
      <div class="b-col b-center ${animateDetail ? "anim" : ""}">${sel ? this.detail(sel) : `<div class="b-muted">select a load</div>`}</div>
      ${this.opts.compact ? "" : `<div class="b-col b-right">${this.approvalPanel(sel)}</div>`}`;
  }

  private payeeName(kind: string, id: string) {
    const db = this.session.conn.db;
    const row = kind === "factor" ? db.factor.id.find(id) : db.carrier.id.find(id);
    return row ? `${row.name} <small>(${kind})</small>` : `${esc(id)} <small>(${esc(kind)})</small>`;
  }

  private banner(i: Item): string {
    const s = i.settlement; const r = i.request;
    const failed = s?.ruleResults.filter(x => !x.passed) ?? [];
    const amount = money(s?.agreedCents ?? i.load.rateCents);
    const payee = s?.payeeKind ? this.payeeName(s.payeeKind, s.payeeId) : "undecidable";
    const approvedBy = r ? [...this.session.conn.db.approval.iter()].filter(a => a.requestId === r.id).at(-1)?.approverId : undefined;
    let head = "", sub = "";
    switch (i.status) {
      case "awaiting_agent": head = "Awaiting agent"; sub = "The agent has not read this invoice yet."; break;
      case "hold": {
        head = "Hold. Pay nobody yet.";
        if (failed.some(f => f.ruleId === "R2") && s) {
          const ex = extractionFor(this.session.conn.db, i.invoiceDocId);
          sub = `The verified assignment says pay <b>${payee}</b>. This invoice says pay <b class="warn">${ex ? this.payeeName(ex.remitToKind, ex.remitToId) : "someone else"}</b>. An unverified instruction cannot replace a verified one.`;
        } else if (failed.some(f => f.ruleId === "R3")) {
          const other = [...this.session.conn.db.paymentRequest.iter()].find(x => x.loadId === i.loadId);
          sub = `This load already has an obligation${other ? ` (request #${other.id}, ${esc(other.invoiceKey.split("|")[1])}, ${esc(other.state)})` : ""}. This invoice bills it again under a new number.`;
        } else sub = `${failed.length} check${failed.length > 1 ? "s" : ""} failed: ${failed.map(f => CHECKS.find(c => c.id === f.ruleId)?.label ?? f.ruleId).join("; ")}.`;
        break;
      }
      case "ready": head = `Ready. ${amount} to ${payee}.`; sub = "All checks passed. Waiting for the agent or AP lead to request payment."; break;
      case "pending": head = `Pending approval. ${amount} to ${payee}.`; sub = `Requested by <b>${esc(r?.requestedBy)}</b>. Needs approval from a different person.`; break;
      case "approved": head = `Approved. ${amount} to ${payee}.`; sub = `Approved by <b>${esc(approvedBy)}</b>, not the requester. Waiting for the payment runner.`; break;
      case "rejected": head = `Rejected.`; sub = `${esc(approvedBy)} rejected this request. The load stays reserved until a controller reconciles it.`; break;
      case "submitting": head = `Submitting. ${amount} to ${payee}.`; sub = `Runner claimed the request. Idempotency key and payload are frozen.`; break;
      case "submitted": head = `Submitted. ${amount} to ${payee}.`; sub = `The mock provider accepted the transfer. Submitted is not settled.`; break;
      case "unknown": head = `Unknown.`; sub = `The provider did not answer. The obligation stays reserved; nobody pays again until the stored key is reconciled.`; break;
      case "failed": head = `Failed.`; sub = `The provider refused the transfer. Still reserved until a controller reconciles.`; break;
      case "simulated_settled": head = `Settled (simulated). ${amount} to ${payee}.`; sub = `Terminal success from the in-process mock provider. No real funds moved.`; break;
    }
    return `<div class="banner ${badgeClass(i.status)}"><div class="banner-head"><span class="badge ${badgeClass(i.status)}">${esc(STATUS_LABEL[i.status])}</span><h3>${head}</h3></div><p>${sub}</p></div>`;
  }

  private detail(i: Item): string {
    const { conn } = this.session;
    const s = i.settlement;
    const docs = documentsFor(conn, i);
    const extraction = extractionFor(conn.db, i.invoiceDocId);
    const chips = s ? CHECKS.map(c => {
      const rs = s.ruleResults.filter(r => r.ruleId === c.id);
      if (rs.length === 0) return "";
      const passed = rs.every(r => r.passed);
      return `<details class="chip ${passed ? "pass" : "fail"}"><summary><span class="mark">${passed ? "✓" : "✕"}</span>${esc(c.label)}<span class="rid">${c.id}</span></summary><div>${rs.map(r => `<p class="${r.passed ? "" : "warn"}">${esc(r.reason)}</p>`).join("")}</div></details>`;
    }).sort((a, b) => Number(b.includes('class="chip fail"')) - Number(a.includes('class="chip fail"'))).map((h, n) => h.replace('<details class="chip', `<details style="--i:${n}" class="chip`)).join("") : "";
    return `
      <div class="b-head">
        <span>${esc(i.loadId)} · ${esc(i.carrier?.name ?? i.load.carrierId)} · ${esc(i.load.lane)}</span>
        <span>${esc(i.load.customer)} · delivered ${i.load.deliveredAt ? shortDate(i.load.deliveredAt) : "—"}</span>
      </div>
      ${this.banner(i)}
      ${s ? `
        <div class="compare">
          <div><i>Policy says pay</i><b>${s.payeeKind ? this.payeeName(s.payeeKind, s.payeeId) : "undecidable"}</b><small>from the verified carrier file and assignments</small></div>
          <div class="${extraction && s.payeeKind && (extraction.remitToKind !== s.payeeKind || extraction.remitToId !== s.payeeId) ? "mismatch" : ""}"><i>Invoice says pay</i><b>${extraction ? this.payeeName(extraction.remitToKind, extraction.remitToId) : "—"}</b><small>read by ${esc(extraction?.method ?? "—")} extraction · confidence ${extraction?.confidence ?? "—"}</small></div>
          <div><i>Amount</i><b>${money(s.agreedCents)}</b><small>agreed rate; invoice ${extraction ? money(extraction.totalCents) : "—"}</small></div>
        </div>
        <div class="b-head sub-head"><span>Checks</span><span>${s.ruleResults.filter(r => r.passed).length}/${s.ruleResults.length} rules passed · click a check for the rule text</span></div>
        <div class="chips">${chips}</div>
      ` : ""}
      <div class="b-head sub-head"><span>Evidence</span><span>${s ? `${s.evidenceIds.length} cited` : ""} · click to open</span></div>
      <div class="docs">${docs.map((d, n) => `
        <a class="doc ${d.kind} ${s?.evidenceIds.includes(d.id) ? "cited" : ""}" style="--i:${n}" ${d.path ? `href="/${esc(d.path)}" target="_blank" rel="noopener"` : ""} title="${esc(d.title)}">
          <img src="/docs/${esc(d.id)}.png" alt="" onerror="this.remove()">
          ${s?.evidenceIds.includes(d.id) ? `<em>cited</em>` : d.kind === "email" ? `<em class="warn">unverified</em>` : ""}
          <b>${esc(d.kind.replace("_", " "))}</b>
          <span>${esc(d.id)} · ${shortDate(d.receivedAt)}</span>
        </a>`).join("")}
      </div>
      ${s?.explanation ? `<details class="prose" open><summary>${s.explanation.startsWith("[template]") ? "Why · template text (Claude unavailable)" : "Why · written by Claude from the policy result"}</summary><p>${esc(s.explanation)}</p></details>` : ""}
      ${s?.decision === "hold" && s.escalationEmail ? `<details class="prose"><summary>${s.explanation.startsWith("[template]") ? "Escalation email · template" : "Escalation email · drafted by Claude"}</summary><pre>${esc(s.escalationEmail)}</pre></details>` : ""}
    `;
  }

  private canSeed() {
    const me = myActor(this.session);
    return !!me && ["controller", "world"].includes(me.role) && [...this.session.conn.db.load.iter()].length === 0;
  }

  // Mirrors the reducer's checkApproval so the panel can say why in advance.
  // The reducer is still the authority; this only drives the hint text.
  private actHint(i: Item | undefined): { can: boolean; text: string } {
    const me = myActor(this.session);
    if (!me) return { can: false, text: this.session.role ? `Another browser already holds the ${this.session.role.replace("_", " ")} seat, so this tab cannot approve. Each seat binds to the first browser that opens it. Close the other tab, then rerun npm run demo:up; open tabs reload and claim their seats.` : "Viewer. Read-only." };
    if (me.role === "agent") return { can: false, text: "The agent identity cannot approve anything." };
    if (me.role === "runner" || me.role === "world") return { can: false, text: `The ${me.role} identity cannot approve payments.` };
    if (!i) return { can: false, text: "Select a load." };
    if (!i.request) return { can: false, text: i.status === "hold" ? "No request exists. The reducer refused to create one; the failed check is in the audit log." : i.status === "ready" ? "Policy passed. Nothing to approve until a request exists." : "Nothing to approve." };
    const res = checkApproval({
      actor: { id: me.id, role: me.role as "ap_lead" | "controller", approval_limit_cents: Number(me.approvalLimitCents) },
      request: { requested_by: i.request.requestedBy, amount_cents: Number(i.request.amountCents), status: i.request.state, snapshot_current: true },
    });
    if (!res.allowed) {
      if (res.reason.includes("own request")) return { can: false, text: `You requested this (${me.id}). A different person must approve it.` };
      if (res.reason.includes("pending")) return { can: false, text: `Already ${i.request.state}. Nothing left to approve.` };
      if (res.reason.includes("limit")) return { can: false, text: `${money(i.request.amountCents)} is over your approval limit (${money(me.approvalLimitCents)}).` };
      return { can: false, text: res.reason };
    }
    return { can: true, text: `You can approve or reject this. Your approval binds ${money(i.request.amountCents)} to ${i.request.payeeId} at bank v${i.request.bankVersion}.` };
  }

  private approvalPanel(i: Item | undefined): string {
    const { session } = this;
    const me = myActor(session);
    const who = me ? esc(me.persona) : session.role ? `unbound ${esc(session.role)}` : "viewer · read-only";
    const r = i?.request;
    const hint = this.actHint(i);
    const last = me && i ? lastActionBy(session.conn, session.conn.identity!.toHexString(), r?.id, i.loadId) : undefined;
    const canRequest = !!me && me.role === "ap_lead" && i?.status === "ready" && !this.busy;
    const payee = r ? (r.payeeKind === "factor" ? session.conn.db.factor.id.find(r.payeeId) : session.conn.db.carrier.id.find(r.payeeId)) : undefined;
    const stepIdx = r ? STEPS.findIndex(([s]) => s === r.state) : -1;
    const sideState = r && ["rejected", "failed", "unknown"].includes(r.state) ? r.state : null;
    return `
      <div class="b-head"><span>You</span><span class="badge pending">${who}</span></div>
      ${session.bindRefusal ? `<div class="refusal refused">${esc(session.bindRefusal)}</div>` : ""}
      ${this.canSeed() ? `<button class="b-btn filled" data-act="seed">seed world</button>` : ""}
      ${r ? `
        <div class="steps">${STEPS.map(([s, label], n) => `<div class="step ${n < stepIdx ? "done" : n === stepIdx ? "now" : ""}"><span class="pt"></span><span>${label}</span></div>`).join("")}
          ${sideState ? `<div class="step side now"><span class="pt"></span><span>${esc(sideState)}${sideState === "unknown" ? " · still reserved" : ""}</span></div>` : ""}
        </div>
        <div class="kv"><span>request</span><span>#${r.id} · by ${esc(r.requestedBy)}</span></div>
        <div class="kv"><span>amount</span><span>${money(r.amountCents)} ${esc(r.currency)}</span></div>
        <div class="kv"><span>payee</span><span>${esc(payee?.name ?? r.payeeId)}</span></div>
        <div class="kv"><span>bank destination</span><span>v${r.bankVersion} · ${esc(payee?.bankLabel ?? "")}</span></div>
        <div class="kv"><span>snapshot</span><span title="${esc(r.snapshotDigest)}">${esc(r.snapshotDigest.slice(0, 8))}…</span></div>
        ${r.idempotencyKey ? `<div class="kv"><span>idempotency key</span><span>${esc(r.idempotencyKey)}</span></div>` : ""}
        ${r.transferId ? `<div class="kv"><span>mock transfer</span><span>${esc(r.transferId)}</span></div>` : ""}
        ${r.lastOutcome ? `<div class="kv"><span>last outcome</span><span>${esc(r.lastOutcome)}</span></div>` : ""}
      ` : i ? `
        <div class="kv"><span>amount</span><span>${money(i.load.rateCents)} USD</span></div>
        <div class="kv"><span>policy payee</span><span>${i.settlement?.payeeKind ? `${esc(i.settlement.payeeId)}` : "—"}</span></div>
        <div class="kv"><span>request</span><span>none</span></div>
      ` : ""}
      <div class="hint ${hint.can ? "ok" : ""}">${hint.text}</div>
      ${this.opts.readOnly ? "" : `
        <button class="b-btn filled ${hint.can && !this.busy ? "" : "disabled"}" data-act="approve" ${hint.can && !this.busy ? "" : "disabled"}>approve</button>
        <button class="b-btn ${hint.can && !this.busy ? "" : "disabled"}" data-act="reject" ${hint.can && !this.busy ? "" : "disabled"}>reject</button>
        ${canRequest ? `<button class="b-btn" data-act="request">request payment</button>` : ""}
      `}
      ${this.notice ? `<div class="refusal ${this.notice.kind}">${this.notice.title ? `<b>${esc(this.notice.title)}</b>` : ""}${esc(this.notice.text)}</div>` :
        last ? `<div class="refusal ${last.outcome === "refused" ? "refused" : "ok"}"><b>database said: ${esc(last.operation.replace(/_/g, " "))} → ${esc(last.outcome)}</b>${esc(last.reason)}</div>` : ""}
      ${me?.role === "controller" && i ? `<div class="tools"><div class="b-head"><span>Controller tools</span></div><button class="b-btn small" data-act="bank">change ${esc(i.load.carrierId)} bank destination</button><div class="b-muted small">Bumps the bank version. Any approval bound to the old version goes stale and cannot dispatch.</div></div>` : ""}
      ${me?.role === "controller" && i && DEFAULT_TARGET ? this.demoControls(i) : ""}
    `;
  }

  private demoControls(i: Item): string {
    const ready = i.status === "ready" && !!i.invoiceDocId;
    const pending = i.request?.state === "pending";
    if (!ready && !pending) return "";
    const off = this.busy ? "disabled" : "";
    return `
      <div class="tools demo-tools">
        <div class="b-head"><span>Demo controls</span><span>run as the agent</span></div>
        ${ready ? `<button class="b-btn small ${off}" data-act="race" ${off}>race: two agent requests at once</button>
          <div class="b-muted small">Sends request_payment for ${esc(i.loadId)} twice, on two agent connections, in the same instant. The database runs reducers one at a time: one reserves, the other is refused and logged.</div>` : ""}
        ${pending ? `<button class="b-btn small ${off}" data-act="agent-approve" ${off}>agent tries to approve #${i.request!.id}</button>
          <div class="b-muted small">The agent identity calls approve_payment. The reducer checks the sender's role and refuses.</div>` : ""}
        <div class="b-muted small">A local demo process holding the agent token makes these calls, not your identity.</div>
      </div>`;
  }

  private async onClick(e: Event) {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-key],[data-act]");
    if (!t) return;
    if (t.dataset.key) { this.select(t.dataset.key); return; }
    if (this.opts.readOnly || this.busy) return;
    const list = items(this.session.conn);
    const sel = this.pick(list);
    const { reducers } = this.session.conn;
    this.busy = true; this.render();
    let notice: Notice | null = null;
    try {
      switch (t.dataset.act) {
        case "seed": await reducers.seedWorld({}); break;
        case "approve": if (sel?.request) await reducers.approvePayment({ requestId: sel.request.id, snapshotDigest: sel.request.snapshotDigest }); break;
        case "reject": {
          const reason = prompt("Reason for rejection:") ?? "";
          if (sel?.request && reason) await reducers.rejectPayment({ requestId: sel.request.id, snapshotDigest: sel.request.snapshotDigest, reason });
          break;
        }
        case "request": if (sel?.invoiceDocId) await reducers.requestPayment({ loadId: sel.loadId, invoiceDocumentId: sel.invoiceDocId }); break;
        case "bank": if (sel) await reducers.updateCarrierBank({ carrierId: sel.load.carrierId, bankLabel: `Changed Bank ••${String(Date.now()).slice(-4)}`, pending: false }); break;
        case "race": if (sel?.invoiceDocId) {
          const r = await demoControl(`race?load=${encodeURIComponent(sel.loadId)}&doc=${encodeURIComponent(sel.invoiceDocId)}`);
          const o = r.outcomes ?? [];
          notice = {
            kind: r.reserved === 1 && o.length === 2 ? "ok" : "refused",
            title: `database said: request payment ×${o.length} → ${o.map(x => x.outcome).join(", ")}`,
            text: o.map((x, n) => `${n === 0 ? "First" : "Second"} call ${x.outcome}${x.request_id ? ` request #${x.request_id}` : ""}${x.outcome === "refused" ? `: ${x.reason}` : "."}`).join(" "),
          };
        } break;
        case "agent-approve": if (sel?.request) {
          const x = (await demoControl(`agent-approve?request=${sel.request.id}`)).outcomes?.[0];
          notice = x
            ? { kind: x.outcome === "refused" ? "refused" : "ok", title: `database said: agent approve payment → ${x.outcome}`, text: x.reason }
            : { kind: "refused", text: "No decision_log row came back from the agent's approve_payment call." };
        } break;
      }
    } catch (err) {
      notice = { text: err instanceof DemoControlError ? err.message : `technical failure (transaction aborted): ${String(err)}`, kind: "refused" };
    } finally {
      this.notice = notice; this.busy = false; this.render();
    }
  }
}
