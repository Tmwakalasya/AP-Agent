import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// In-process mock payment provider. It exists to exercise the runner's
// idempotency and recovery paths. It is labeled as a mock in every response;
// no bank, no sandbox, no funds.

export type Transfer = {
  transfer_id: string; idempotency_key: string; status: "accepted" | "settled";
  request_id: string; load_id: string; amount_cents: string; currency: string;
  payee: { kind: string; id: string; name: string; bank_version: number; bank_label: string };
  accepted_at: string; settled_at: string | null; payload: string;
};
export type ProviderOptions = { port?: number; latencyMs?: number; settleAfterMs?: number; stateFile?: string | null };
export type Provider = {
  url: string; server: Server; transfers(): Transfer[]; close(): Promise<void>;
  chaos: { dropResponseOnce: boolean };
};

const LABEL = { provider: "remit-to mock provider", funds_move: false, note: "In-process simulation. Terminal state is simulated_settled." };

export function startMockProvider(opts: ProviderOptions = {}): Promise<Provider> {
  const latency = opts.latencyMs ?? 400;
  const settleAfter = opts.settleAfterMs ?? 4000;
  const stateFile = opts.stateFile === undefined ? resolve("agent/.cache/mock-provider.json") : opts.stateFile;
  const byKey = new Map<string, Transfer>();
  if (stateFile && existsSync(stateFile)) {
    try { for (const t of JSON.parse(readFileSync(stateFile, "utf8")) as Transfer[]) byKey.set(t.idempotency_key, t); }
    catch (e) { console.log(`[mock-provider] ignoring unreadable state file ${stateFile}: ${String(e)}`); }
  }
  const persist = () => {
    if (!stateFile) return;
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(`${stateFile}.tmp`, JSON.stringify([...byKey.values()], null, 2));
    renameSync(`${stateFile}.tmp`, stateFile);
  };
  const chaos = { dropResponseOnce: false };

  // Settlement is lazy: a transfer reads as settled once it is old enough.
  const view = (t: Transfer): Transfer => {
    if (t.status === "accepted" && Date.now() - Date.parse(t.accepted_at) >= settleAfter) { t.status = "settled"; t.settled_at = new Date().toISOString(); persist(); }
    return t;
  };
  const send = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify({ ...LABEL, ...(body as object) })); };
  const readBody = (req: IncomingMessage) => new Promise<string>(r => { let s = ""; req.on("data", c => s += c); req.on("end", () => r(s)); });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.replace(/\/$/, "");
    if (req.method === "GET" && path === "") return send(res, 200, { transfers: byKey.size, chaos });
    if (req.method === "GET" && path === "/v1/transfers") return send(res, 200, { transfers: [...byKey.values()].map(view) });
    if (req.method === "GET" && path.startsWith("/v1/transfers/by-key/")) {
      const t = byKey.get(decodeURIComponent(path.slice("/v1/transfers/by-key/".length)));
      return t ? send(res, 200, view(t)) : send(res, 404, { error: "no transfer for that idempotency key" });
    }
    if (req.method === "GET" && path.startsWith("/v1/transfers/")) {
      const id = path.slice("/v1/transfers/".length);
      const t = [...byKey.values()].find(x => x.transfer_id === id);
      return t ? send(res, 200, view(t)) : send(res, 404, { error: "unknown transfer" });
    }
    if (req.method === "POST" && path === "/v1/chaos") {
      let b: { drop_response_once?: boolean };
      try { b = JSON.parse(await readBody(req) || "{}"); } catch { return send(res, 400, { error: "invalid JSON" }); }
      if (typeof b.drop_response_once === "boolean") chaos.dropResponseOnce = b.drop_response_once;
      return send(res, 200, { chaos });
    }
    if (req.method === "POST" && path === "/v1/transfers") {
      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "invalid JSON" }); }
      const key = String(req.headers["idempotency-key"] ?? "");
      if (!key || key !== body.idempotency_key) return send(res, 400, { error: "Idempotency-Key header must match payload.idempotency_key" });
      await new Promise(r => setTimeout(r, latency));
      const existing = byKey.get(key);
      if (existing) {
        if (existing.payload !== raw) return send(res, 409, { error: "idempotency key reused with a different payload", transfer_id: existing.transfer_id });
        return send(res, 200, { ...view(existing), replayed: true });
      }
      const payee = body.payee as Transfer["payee"];
      const t: Transfer = {
        transfer_id: `mtr_${randomBytes(6).toString("hex")}`, idempotency_key: key, status: "accepted",
        request_id: String(body.request_id), load_id: String(body.load_id), amount_cents: String(body.amount_cents), currency: String(body.currency),
        payee, accepted_at: new Date().toISOString(), settled_at: null, payload: raw,
      };
      byKey.set(key, t); persist();
      if (chaos.dropResponseOnce) { chaos.dropResponseOnce = false; console.log(`[mock-provider] accepted ${t.transfer_id} for ${key}, then dropped the response (chaos)`); req.socket.destroy(); return; }
      console.log(`[mock-provider] accepted ${t.transfer_id} · ${key} · ${t.amount_cents} ${t.currency} → ${payee?.name ?? payee?.id} (bank v${payee?.bank_version}) · simulated`);
      return send(res, 201, { ...t, replayed: false });
    }
    send(res, 404, { error: "not found" });
  });

  return new Promise(resolveP => {
    server.listen(opts.port ?? 4310, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolveP({
        url: `http://127.0.0.1:${addr.port}`, server, chaos,
        transfers: () => [...byKey.values()].map(view),
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MOCK_PROVIDER_PORT ?? 4310);
  const p = await startMockProvider({ port });
  console.log(`[mock-provider] listening on ${p.url} · ${p.transfers().length} transfer(s) on file · MOCK, no funds move`);
  console.log(`[mock-provider] POST ${p.url}/v1/chaos {"drop_response_once":true} to lose the next accept response`);
}
