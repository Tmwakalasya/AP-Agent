import { DbConnection } from "../../bindings/index.ts";

export type PersonaKey = "viewer" | "agent" | "ap" | "controller" | "runner" | "world";
const ROLE: Record<PersonaKey, string | null> = {
  viewer: null, agent: "agent", ap: "ap_lead", controller: "controller", runner: "runner", world: "world",
};

export const HOST = (import.meta as { env?: Record<string, string> }).env?.VITE_SPACETIME_HOST ?? "ws://127.0.0.1:3000";
export const DB = (import.meta as { env?: Record<string, string> }).env?.VITE_SPACETIME_DB ?? "remit-to";

const TABLES = ["actor", "carrier", "factor", "assignment", "load", "document", "extraction",
  "settlement", "payment_request", "approval", "decision_log"];

export type Session = {
  conn: DbConnection;
  persona: PersonaKey;
  role: string | null;
  status: "connecting" | "live" | "error";
  error?: string;
  // Reason text when the persona could not be bound to this identity.
  bindRefusal?: string;
  onChange(cb: () => void): void;
};

export function personaFromUrl(): PersonaKey {
  const p = new URLSearchParams(location.search).get("persona") ?? "viewer";
  return (p in ROLE ? p : "viewer") as PersonaKey;
}

// Each persona keeps its own token in localStorage, so two tabs with different
// ?persona= values are two different identities to the database.
export function connect(persona: PersonaKey): Session {
  const key = `remit-to.token.${persona}`;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(cb => cb());
  const session: Session = {
    conn: undefined as unknown as DbConnection, persona, role: ROLE[persona], status: "connecting",
    onChange: cb => listeners.add(cb),
  };

  const conn = DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB)
    .withToken(localStorage.getItem(key) ?? undefined)
    .onConnectError((_ctx, err) => { session.status = "error"; session.error = String(err?.message ?? err); notify(); })
    .onDisconnect((_ctx, err) => { session.status = "error"; session.error = err ? String(err.message) : "disconnected"; notify(); })
    .onConnect((c, _identity, token) => {
      localStorage.setItem(key, token);
      c.subscriptionBuilder()
        .onApplied(async () => {
          session.status = "live";
          await bindPersona(session);
          notify();
        })
        .onError(() => { session.status = "error"; session.error = "subscription failed"; notify(); })
        .subscribe(TABLES.map(t => `SELECT * FROM ${t}`));
    })
    .build();
  session.conn = conn;

  // Any table change re-renders; the data set is tiny.
  const hook = (table: { onInsert(cb: () => void): void; onDelete(cb: () => void): void; onUpdate?(cb: () => void): void }) => {
    table.onInsert(notify); table.onDelete(notify); table.onUpdate?.(notify);
  };
  const db = conn.db as unknown as Record<string, Parameters<typeof hook>[0]>;
  for (const t of ["actor", "carrier", "factor", "assignment", "load", "document", "extraction",
    "settlement", "paymentRequest", "approval", "decisionLog"]) hook(db[t]);
  return session;
}

export function myActor(session: Session) {
  const me = session.conn.identity;
  if (!me) return undefined;
  return [...session.conn.db.actor.iter()].find(a => a.identity && a.identity.isEqual(me));
}

async function bindPersona(session: Session) {
  if (!session.role) return;
  if (myActor(session)) return;
  try {
    await session.conn.reducers.bootstrapPersona({ role: session.role });
  } catch (e) { session.bindRefusal = String(e); return; }
  if (!myActor(session)) {
    const me = session.conn.identity!;
    const row = [...session.conn.db.decisionLog.iter()]
      .filter(l => l.operation === "bootstrap_persona" && l.actorIdentity.isEqual(me))
      .sort((a, b) => Number(b.id - a.id))[0];
    session.bindRefusal = row?.reason ?? "Persona could not be bound.";
  }
}
