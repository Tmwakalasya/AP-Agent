import type { Session } from "./stdb.ts";
import { myActor } from "./stdb.ts";
import { auditFor, documentsFor, items, lastActionBy, money, shortDate, clock, STATUS_LABEL } from "./model.ts";
import type { Item, Status } from "./model.ts";

export type BoardOptions = { compact?: boolean; readOnly?: boolean };

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const badgeClass = (s: Status) => ({
  hold: "hold", unknown: "hold", failed: "dim", rejected: "dim", awaiting_agent: "dim", ready: "ready",
  pending: "pending", approved: "ok", submitting: "sub", submitted: "sub", simulated_settled: "settled",
} as Record<Status, string>)[s];

export class Board {
  private selected: string | null = null;
  private prevStatus = new Map<string, Status>();
  private flashing = new Set<string>();
  private lastDetailKey = "";
  private busy = false;
  private notice: { text: string; kind: "ok" | "refused" } | null = null;

  constructor(private root: HTMLElement, private session: Session, private opts: BoardOptions = {}) {
    root.classList.add("board");
    if (opts.compact) root.classList.add("compact");
    root.addEventListener("click", e => this.onClick(e));
    session.onChange(() => this.render());
    this.render();
  }

  private pick(list: Item[]): Item | undefined {
    if (this.selected) { const hit = list.find(i => i.key === this.selected); if (hit) return hit; }
    return list.find(i => i.status === "hold") ?? list[0];
  }

  render() {
    const { session } = this;
    if (session.status !== "live") {
      this.root.innerHTML = `<div class="b-empty">${session.status === "error" ? `connection error · ${esc(session.error)}` : "connecting to spacetimedb…"}</div>`;
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
        ${list.length === 0 ? `<div class="b-muted">no loads yet${this.canSeed() ? " · seed the world →" : ""}</div>` : ""}
        ${list.map(i => `
          <div class="load ${sel?.key === i.key ? "active" : ""} ${this.flashing.has(i.key) ? "flash" : ""}" data-key="${esc(i.key)}">
            <span class="load-id">${esc(i.loadId)}${i.rebill ? ` <em>re-bill</em>` : ""} <span class="load-carrier">${esc(i.carrier?.name.split(" ")[0] ?? "")}</span></span>
            <span class="badge ${badgeClass(i.status)}">${esc(STATUS_LABEL[i.status])}</span>
          </div>`).join("")}
        <div class="b-head audit-head"><span>Audit</span><span>decision_log</span></div>
        <div class="audit">${auditFor(session.conn, undefined, this.opts.compact ? 6 : 14).map(l => `
          <div class="audit-row ${l.outcome}"><span class="t">${clock(l.at)}</span> <span class="who">${esc(l.actorId)}</span> ${esc(l.operation)} ${l.loadId ? esc(l.loadId) : ""} → <b>${esc(l.outcome)}</b></div>`).join("")}
        </div>
      </div>
      <div class="b-col b-center ${animateDetail ? "anim" : ""}">${sel ? this.detail(sel) : `<div class="b-muted">select a load</div>`}</div>
      ${this.opts.compact ? "" : `<div class="b-col b-right">${this.approvalPanel(sel)}</div>`}`;
  }

  private detail(i: Item): string {
    const { conn } = this.session;
    const s = i.settlement;
    const docs = documentsFor(conn, i);
    const failed = s?.ruleResults.filter(r => !r.passed) ?? [];
    const extraction = i.invoiceDocId ? conn.db.extraction.documentId.find(i.invoiceDocId) : undefined;
    return `
      <div class="b-head">
        <span>${esc(i.loadId)} · ${esc(i.carrier?.name ?? i.load.carrierId)} · ${money(i.load.rateCents)}</span>
        <span class="badge ${badgeClass(i.status)}">${esc(STATUS_LABEL[i.status])}${failed.length ? ` · ${failed.map(r => r.ruleId).join(" ")}` : ""}</span>
      </div>
      <div class="lane">${esc(i.load.lane)} · ${esc(i.load.customer)} · delivered ${i.load.deliveredAt ? shortDate(i.load.deliveredAt) : "—"}</div>
      <div class="docs">${docs.map((d, n) => `
        <a class="doc ${d.kind} ${s?.evidenceIds.includes(d.id) ? "cited" : ""}" style="--i:${n}" ${d.path ? `href="/${esc(d.path)}" target="_blank" rel="noopener"` : ""} title="${esc(d.title)}">
          <img src="/docs/${esc(d.id)}.png" alt="" onerror="this.remove()">
          <b>${esc(d.kind.replace("_", " "))}</b>
          <span>${esc(d.id)}<br>${shortDate(d.receivedAt)} · ${esc(d.sender.split("@")[1] ?? d.sender)}</span>
        </a>`).join("")}
      </div>
      ${s ? `
        <div class="rules">${s.ruleResults.map((r, n) => `
          <div class="rule ${r.passed ? "pass" : "fail"}" style="--i:${n}"><span class="mark">${r.passed ? "✓" : "✕"}</span><span class="rid">${esc(r.ruleId)}</span><span>${esc(r.reason)}</span></div>`).join("")}
        </div>
        <div class="kv-strip">
          <span><i>policy payee</i> ${s.payeeKind ? `${esc(s.payeeKind)} ${esc(s.payeeId)}` : "undecidable"}</span>
          <span><i>requested</i> ${extraction ? `${esc(extraction.remitToKind)} ${esc(extraction.remitToId)}` : "—"}</span>
          <span><i>agreed</i> ${money(s.agreedCents)}</span>
          <span><i>evidence</i> ${s.evidenceIds.map(esc).join(" · ")}</span>
          <span><i>snapshot</i> ${esc(s.snapshotDigest.slice(0, 8))}</span>
        </div>
        ${s.explanation ? `<div class="explain"><b>Claude · explanation${extraction ? ` · ${esc(extraction.method)} extraction · confidence ${extraction.confidence}` : ""}</b>${esc(s.explanation)}</div>` : ""}
        ${s.decision === "hold" && s.escalationEmail ? `<div class="explain email"><b>Claude · drafted escalation</b><pre>${esc(s.escalationEmail)}</pre></div>` : ""}
      ` : `<div class="b-muted">${i.status === "awaiting_agent" ? "the agent has not read this invoice yet" : ""}</div>`}
    `;
  }

  private canSeed() {
    const me = myActor(this.session);
    return !!me && ["controller", "world"].includes(me.role) && [...this.session.conn.db.load.iter()].length === 0;
  }

  private approvalPanel(i: Item | undefined): string {
    const { session } = this;
    const me = myActor(session);
    const who = me ? `${esc(me.persona)}` : session.role ? `unbound ${esc(session.role)}` : "viewer · read-only";
    const r = i?.request;
    const last = me && i ? lastActionBy(session.conn, session.conn.identity!.toHexString(), r?.id, i.loadId) : undefined;
    const canApprove = !!me && ["ap_lead", "controller"].includes(me.role) && r?.state === "pending" && !this.busy;
    const canRequest = !!me && me.role === "ap_lead" && i?.status === "ready" && !this.busy;
    const payee = r ? (r.payeeKind === "factor" ? session.conn.db.factor.id.find(r.payeeId) : session.conn.db.carrier.id.find(r.payeeId)) : undefined;
    return `
      <div class="b-head"><span>Approval</span><span class="badge pending">you: ${who}</span></div>
      ${session.bindRefusal ? `<div class="refusal">${esc(session.bindRefusal)}</div>` : ""}
      ${this.canSeed() ? `<button class="b-btn filled" data-act="seed">seed world</button>` : ""}
      ${r ? `
        <div class="kv"><span>request</span><span>#${r.id}</span></div>
        <div class="kv"><span>amount</span><span>${money(r.amountCents)} ${esc(r.currency)}</span></div>
        <div class="kv"><span>payee</span><span>${esc(r.payeeId)} ${esc(payee?.name ?? "")}</span></div>
        <div class="kv"><span>bank</span><span>v${r.bankVersion} · ${esc(payee?.bankLabel ?? "")}</span></div>
        <div class="kv"><span>requested by</span><span>${esc(r.requestedBy)}</span></div>
        <div class="kv"><span>state</span><span class="badge ${badgeClass(r.state as Status)}">${esc(STATUS_LABEL[r.state as Status] ?? r.state)}</span></div>
        <div class="kv"><span>snapshot</span><span>${esc(r.snapshotDigest.slice(0, 8))}…</span></div>
        ${r.idempotencyKey ? `<div class="kv"><span>idempotency key</span><span>${esc(r.idempotencyKey)}</span></div>` : ""}
        ${r.transferId ? `<div class="kv"><span>mock transfer</span><span>${esc(r.transferId)}</span></div>` : ""}
        ${r.lastOutcome ? `<div class="kv"><span>last outcome</span><span>${esc(r.lastOutcome)}</span></div>` : ""}
      ` : i ? `
        <div class="kv"><span>amount</span><span>${money(i.load.rateCents)} USD</span></div>
        <div class="kv"><span>policy payee</span><span>${i.settlement?.payeeKind ? `${esc(i.settlement.payeeKind)} ${esc(i.settlement.payeeId)}` : "—"}</span></div>
        <div class="kv"><span>request</span><span>none</span></div>
      ` : ""}
      ${this.opts.readOnly ? "" : `
        <button class="b-btn filled ${canApprove ? "" : "disabled"}" data-act="approve" ${canApprove ? "" : "disabled"}>approve</button>
        <button class="b-btn ${canApprove ? "" : "disabled"}" data-act="reject" ${canApprove ? "" : "disabled"}>reject</button>
        ${canRequest ? `<button class="b-btn" data-act="request">request payment</button>` : ""}
      `}
      ${this.notice ? `<div class="refusal ${this.notice.kind}">${esc(this.notice.text)}</div>` :
        last ? `<div class="refusal ${last.outcome === "refused" ? "refused" : "ok"}"><b>${esc(last.operation)} → ${esc(last.outcome)}</b><br>${esc(last.reason)}</div>` :
        i && !r ? `<div class="refusal dim">${i.status === "hold" ? "No executable request. The agent did not create a payment request; the failed rule is committed to decision_log." : i.status === "ready" ? "Policy passed. Waiting for the agent or AP lead to request payment." : "Nothing to approve yet."}</div>` : ""}
      ${me?.role === "controller" && i ? `<div class="tools"><span class="b-head"><span>Controller tools</span></span><button class="b-btn small" data-act="bank">change ${esc(i.load.carrierId)} bank destination</button></div>` : ""}
    `;
  }

  private async onClick(e: Event) {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-key],[data-act]");
    if (!t) return;
    if (t.dataset.key) { this.selected = t.dataset.key; this.notice = null; this.render(); return; }
    if (this.opts.readOnly || this.busy) return;
    const list = items(this.session.conn);
    const sel = this.pick(list);
    const { reducers } = this.session.conn;
    this.busy = true; this.render();
    try {
      switch (t.dataset.act) {
        case "seed": await reducers.seedWorld(); break;
        case "approve": if (sel?.request) await reducers.approvePayment({ requestId: sel.request.id, snapshotDigest: sel.request.snapshotDigest }); break;
        case "reject": {
          const reason = prompt("Reason for rejection:") ?? "";
          if (sel?.request && reason) await reducers.rejectPayment({ requestId: sel.request.id, snapshotDigest: sel.request.snapshotDigest, reason });
          break;
        }
        case "request": if (sel?.invoiceDocId) await reducers.requestPayment({ loadId: sel.loadId, invoiceDocumentId: sel.invoiceDocId }); break;
        case "bank": if (sel) await reducers.updateCarrierBank({ carrierId: sel.load.carrierId, bankLabel: `Changed Bank ••${String(Date.now()).slice(-4)}`, pending: false }); break;
      }
      this.notice = null;
    } catch (err) {
      this.notice = { text: `technical failure (transaction aborted): ${String(err)}`, kind: "refused" };
    } finally {
      this.busy = false; this.render();
    }
  }
}
