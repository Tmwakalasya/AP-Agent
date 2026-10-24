import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DbConnection } from "../../bindings/index.ts";

export type Persona = "world" | "agent" | "ap_lead" | "controller" | "runner";

const here = dirname(fileURLToPath(import.meta.url));
const tokenDir = join(here, "..", ".tokens");

export const HOST = process.env.SPACETIME_HOST ?? "ws://127.0.0.1:3000";
export const DB = process.env.SPACETIME_DB ?? "remit-to";

const ALL_TABLES = [
  "actor", "carrier", "factor", "assignment", "load", "document", "extraction",
  "settlement", "payment_request", "approval", "decision_log",
];

// One token file per persona so each process keeps its own identity across
// restarts. Tokens are local demo credentials only.
function tokenPath(persona: string) { return join(tokenDir, `${persona}.token`); }
export function loadToken(persona: string): string | undefined {
  const p = tokenPath(persona);
  return existsSync(p) ? readFileSync(p, "utf8").trim() : undefined;
}
export function saveToken(persona: string, token: string) {
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(tokenPath(persona), token);
}

// onDrop fires when an established connection closes. Long-running processes
// pass a handler that exits, so a supervisor sees the failure instead of a
// process that looks alive but can no longer reach the database.
export function connect(persona: string, opts: { host?: string; db?: string; fresh?: boolean; onDrop?: (err?: Error) => void } = {}): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    let established = false;
    const builder = DbConnection.builder()
      .withUri(opts.host ?? HOST)
      .withDatabaseName(opts.db ?? DB)
      .withToken(opts.fresh ? undefined : loadToken(persona))
      .onConnectError((_ctx, err) => reject(err))
      .onDisconnect((_ctx, err) => { if (established) opts.onDrop?.(err ?? undefined); })
      .onConnect((conn, _identity, token) => {
        established = true;
        saveToken(persona, token);
        conn.subscriptionBuilder()
          .onApplied(() => resolve(conn))
          .onError((ctx) => reject(new Error(`subscription error: ${String((ctx as { event?: unknown }).event)}`)))
          .subscribe(ALL_TABLES.map(t => `SELECT * FROM ${t}`));
      });
    builder.build();
  });
}

// Binds the connection's identity to a persona unless it is already bound.
export async function ensurePersona(conn: DbConnection, role: Persona) {
  const me = conn.identity!;
  const bound = [...conn.db.actor.iter()].find(a => a.identity && a.identity.isEqual(me));
  if (bound) return bound;
  await conn.reducers.bootstrapPersona({ role });
  const after = [...conn.db.actor.iter()].find(a => a.identity && a.identity.isEqual(me));
  if (!after) {
    const last = [...conn.db.decisionLog.iter()].filter(l => l.operation === "bootstrap_persona").at(-1);
    throw new Error(`bootstrap_persona(${role}) did not bind: ${last?.reason ?? "no log row"}`);
  }
  return after;
}

export function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
