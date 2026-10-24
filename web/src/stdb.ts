import { DbConnection } from "../../bindings/index.ts";

export type PersonaKey = "viewer" | "agent" | "ap" | "controller" | "runner" | "world";
const ROLE: Record<PersonaKey, string | null> = {
  viewer: null, agent: "agent", ap: "ap_lead", controller: "controller", runner: "runner", world: "world",
};

const env = (import.meta as { env?: Record<string, string> }).env ?? {};
const params = new URLSearchParams(location.search);
// ?host= and ?db= let one build point at another database (a second local
// instance, maincloud) without rebuilding. Tokens are scoped to that target.
export const HOST = params.get("host") ?? env.VITE_SPACETIME_HOST ?? "ws://127.0.0.1:3000";
export const DB = params.get("db") ?? env.VITE_SPACETIME_DB ?? "remit-to";
export const DEFAULT_TARGET = HOST === "ws://127.0.0.1:3000" && DB === "remit-to";
// ?demo sizes the board for screen recording.
export const DEMO = params.has("demo");

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
  const p = params.get("persona") ?? "viewer";
  return (p in ROLE ? p : "viewer") as PersonaKey;
}

// ?load=L-2041 or ?load=L-2037:D-inv-5521R preselects a board row.
export function loadFromUrl(): string | null {
  return params.get("load");
}

// Rewrites ?load= in place so a refresh or a persona-tab switch keeps the row.
export function rememberLoad(key: string) {
  const url = new URL(location.href);
  url.searchParams.set("load", key);
  history.replaceState(null, "", url);
}

// Builds a same-target link for another persona, carrying ?load= along.
export function personaHref(persona: PersonaKey, load?: string | null): string {
  const url = new URL("/app/", location.origin);
  url.searchParams.set("persona", persona);
  if (load) url.searchParams.set("load", load);
  if (DEMO) url.searchParams.set("demo", "");
  if (!DEFAULT_TARGET) { url.searchParams.set("host", HOST); url.searchParams.set("db", DB); }
  return url.pathname + url.search;
}

// Each persona keeps its own token in localStorage, so two tabs with different
// ?persona= values are two different identities to the database. A token from
// one server is meaningless on another, so non-default targets get their own key.
export function connect(persona: PersonaKey): Session {
  const key = DEFAULT_TARGET ? `remit-to.token.${persona}` : `remit-to.token.${persona}@${DB}@${HOST}`;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(cb => cb());
  const session: Session = {
    conn: undefined as unknown as DbConnection, persona, role: ROLE[persona], status: "connecting",
    onChange: cb => listeners.add(cb),
  };

  // The SDK reconnects an established connection on its own, replays the
  // subscription and fires onApplied again, which re-binds the persona after
  // an npm run reset. It gives up on a failed first connection (server not up
  // yet) and on a token the server will not honour; those two cases are
  // retried here so a tab recovers without a manual refresh.
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let clearedToken = false;
  const later = (why: string) => {
    if (timer) return;
    attempt += 1;
    const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 3), 8000);
    session.status = "error"; session.error = `${why} · retrying in ${Math.round(delay / 1000)}s`;
    notify();
    timer = setTimeout(() => { timer = undefined; dial(); }, delay);
  };
  const waiting = (why: string | undefined, delayMs: number | undefined) => {
    session.status = "connecting";
    session.error = `${why ?? "disconnected"} · reconnecting${delayMs ? ` in ${Math.round(delayMs / 1000)}s` : ""}`;
    notify();
  };

  const hook = (table: { onInsert(cb: () => void): void; onDelete(cb: () => void): void; onUpdate?(cb: () => void): void }) => {
    table.onInsert(notify); table.onDelete(notify); table.onUpdate?.(notify);
  };

  function dial() {
    const token = localStorage.getItem(key) ?? undefined;
    session.status = "connecting"; session.error = undefined;
    const conn = DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(DB)
      .withToken(token)
      .withAutomaticReconnect({ minDelayMs: 1000, maxDelayMs: 8000 })
      .onConnectError((_ctx, err, nextAttempt, delayMs) => {
        const msg = String(err?.message ?? err);
        if (nextAttempt !== undefined) { waiting(msg, delayMs); return; }
        // Terminal for the SDK. A saved token is dropped once: the server may
        // have been re-keyed, or the identity may no longer be the one it issued.
        if (token && !clearedToken && !/ECONNREFUSED|Failed to fetch|NetworkError|refused|unreachable/i.test(msg)) {
          clearedToken = true;
          localStorage.removeItem(key);
          dial();
          return;
        }
        later(msg);
      })
      .onDisconnect((_ctx, err, nextAttempt, delayMs) => {
        if (nextAttempt !== undefined) { waiting(err?.message, delayMs); return; }
        later(err ? String(err.message) : "disconnected");
      })
      .onAutomaticReconnect(() => { attempt = 0; session.status = "live"; session.error = undefined; notify(); })
      .onConnect((c, _identity, tok) => {
        attempt = 0;
        localStorage.setItem(key, tok);
        c.subscriptionBuilder()
          .onApplied(async () => {
            session.status = "live"; session.error = undefined; session.bindRefusal = undefined;
            await bindPersona(session);
            notify();
          })
          .onError(() => later("subscription failed"))
          .subscribe(TABLES.map(t => `SELECT * FROM ${t}`));
      })
      .build();
    session.conn = conn;

    // Any table change re-renders; the data set is tiny.
    const db = conn.db as unknown as Record<string, Parameters<typeof hook>[0]>;
    for (const t of ["actor", "carrier", "factor", "assignment", "load", "document", "extraction",
      "settlement", "paymentRequest", "approval", "decisionLog"]) hook(db[t]);
    notify();
  }

  dial();
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
