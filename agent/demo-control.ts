import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { connect, ensurePersona, sleep } from "./lib/connect.ts";

// Demo-only control behind the board's "demo controls" box. Vite proxies
// /demo-control here. It holds the agent token, so it can do exactly what the
// agent can do and nothing more: every call goes through the same reducers
// and every outcome is a decision_log row.
//
//   POST /race?load=L-2033&doc=D-inv-7710   two request_payment calls at once, on two connections
//   POST /agent-approve?request=3           the agent tries to approve; the reducer refuses by role

const PORT = Number(process.env.DEMO_CONTROL_PORT ?? 4311);
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} [demo-control] ${line}`);

// Two connections, one agent identity: two workers that picked up the same invoice.
const dropped = (e?: Error) => { log(`lost the database connection${e?.message ? `: ${e.message}` : ""}; exiting`); process.exit(1); };
const a = await connect("agent", { onDrop: dropped });
await ensurePersona(a, "agent");
const b = await connect("agent", { onDrop: dropped });
let busy = false;
const me = a.identity!;

type LogRow = ReturnType<typeof a.db.decisionLog.iter> extends Iterable<infer R> ? R : never;
const maxLogId = () => [...a.db.decisionLog.iter()].reduce((m, l) => (l.id > m ? l.id : m), 0n);
const agentLogs = (op: string, afterId: bigint, match: (l: LogRow) => boolean) =>
  [...a.db.decisionLog.iter()].filter(l => l.operation === op && l.id > afterId && l.actorIdentity.isEqual(me) && match(l)).sort((x, y) => Number(x.id - y.id));

// The other connection's commit can reach this cache a moment after our own.
async function waitForRows(get: () => LogRow[], n: number, ms = 2000) {
  const until = Date.now() + ms;
  let rows = get();
  while (rows.length < n && Date.now() < until) { await sleep(25); rows = get(); }
  return rows;
}
const row = (l: LogRow) => ({ log_id: String(l.id), outcome: l.outcome, reason: l.reason, request_id: l.requestId ? String(l.requestId) : null });

async function race(loadId: string, invoiceDocumentId: string) {
  const before = maxLogId();
  const t0 = performance.now();
  await Promise.all([
    a.reducers.requestPayment({ loadId, invoiceDocumentId }),
    b.reducers.requestPayment({ loadId, invoiceDocumentId }),
  ]);
  const elapsed = Math.round(performance.now() - t0);
  const rows = await waitForRows(() => agentLogs("request_payment", before, l => l.loadId === loadId), 2);
  const reserved = rows.filter(l => l.outcome === "reserved").length;
  log(`race ${loadId}: 2 calls in ${elapsed}ms → ${rows.map(l => l.outcome).join(", ")}`);
  return { load: loadId, sent: 2, elapsed_ms: elapsed, reserved, refused: rows.length - reserved, outcomes: rows.map(row) };
}

async function agentApprove(requestId: bigint) {
  const request = a.db.paymentRequest.id.find(requestId);
  if (!request) return null;
  const before = maxLogId();
  await a.reducers.approvePayment({ requestId, snapshotDigest: request.snapshotDigest });
  const rows = await waitForRows(() => agentLogs("approve_payment", before, () => true), 1);
  log(`agent approve #${requestId}: ${rows.map(l => `${l.outcome} (${l.reason})`).join(", ")}`);
  return { request_id: String(requestId), outcomes: rows.map(row) };
}

const send = (res: ServerResponse, code: number, body: object) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ demo_control: true, ...body }));
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname.replace(/\/$/, "");
  try {
    if (req.method === "GET" && path === "") return send(res, 200, { identity: me.toHexString().slice(0, 8) });
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    if (busy) return send(res, 409, { error: "another demo action is still in flight" });
    busy = true;
    if (path === "/race") {
      const load = url.searchParams.get("load"), doc = url.searchParams.get("doc");
      if (!load || !doc) return send(res, 400, { error: "race needs ?load= and ?doc=" });
      return send(res, 200, await race(load, doc));
    }
    if (path === "/agent-approve") {
      const id = url.searchParams.get("request");
      if (!id || !/^\d+$/.test(id)) return send(res, 400, { error: "agent-approve needs ?request=<id>" });
      const result = await agentApprove(BigInt(id));
      return result ? send(res, 200, result) : send(res, 404, { error: `unknown request #${id}` });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    log(`failed: ${String(e)}`);
    send(res, 500, { error: String(e) });
  } finally {
    busy = false;
  }
}).listen(PORT, "127.0.0.1", () => log(`listening on http://127.0.0.1:${PORT} as agent · identity ${me.toHexString().slice(0, 8)} · demo only`));
