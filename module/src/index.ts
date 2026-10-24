import { schema, table, t, SenderError } from 'spacetimedb/server';

// Probe module: verifies local publish and the refusal-as-committed-event
// behaviour before the real schema is built on top of it.
const probeState = table({ name: 'probe_state', public: true }, {
  key: t.string().primaryKey(),
  value: t.string(),
});
const probeLog = table({ name: 'probe_log', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  op: t.string(),
  outcome: t.string(),
});

const spacetimedb = schema({ probeState, probeLog });
export default spacetimedb;

// Refusal path A: write the audit row, leave business state alone, return normally.
export const probeRefuse = spacetimedb.reducer({ key: t.string() }, (ctx, { key }) => {
  ctx.db.probeLog.insert({ id: 0n, op: `refuse:${key}`, outcome: 'refused' });
});

// Refusal path B: write the audit row, then throw. Expectation: the row is rolled back.
export const probeThrow = spacetimedb.reducer({ key: t.string() }, (ctx, { key }) => {
  ctx.db.probeLog.insert({ id: 0n, op: `throw:${key}`, outcome: 'refused-then-threw' });
  throw new SenderError('refused by throwing');
});

export const probeSet = spacetimedb.reducer({ key: t.string(), value: t.string() }, (ctx, { key, value }) => {
  const existing = ctx.db.probeState.key.find(key);
  if (existing) ctx.db.probeState.key.update({ ...existing, value });
  else ctx.db.probeState.insert({ key, value });
  ctx.db.probeLog.insert({ id: 0n, op: `set:${key}`, outcome: 'ok' });
});
