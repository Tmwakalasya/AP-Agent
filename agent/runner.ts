import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, ensurePersona } from "./lib/connect.ts";
import { runnerPass } from "./lib/runner-core.ts";

// The payment runner process. Holds the `runner` identity: it can claim
// approved requests and report provider outcomes, nothing else.
//
//   npx tsx agent/runner.ts                      watch and dispatch
//   npx tsx agent/runner.ts --once               one pass, then exit
//   npx tsx agent/runner.ts --crash-after-accept die after the provider accepts, before recording
//   PROVIDER_URL=http://127.0.0.1:4310           mock provider (default)

const ONCE = process.argv.includes("--once");
const CRASH = process.argv.includes("--crash-after-accept");
const PROVIDER_URL = process.env.PROVIDER_URL ?? "http://127.0.0.1:4310";
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} [runner] ${line}`);

// One runner at a time. Two would both watch the same approvals; the claim
// reducer keeps them from paying twice, but which one wins is luck, and the
// crash clip depends on knowing which process dies.
const LOCK = "agent/.cache/runner.lock";
if (existsSync(LOCK)) {
  const other = Number(readFileSync(LOCK, "utf8"));
  let alive = false;
  try { process.kill(other, 0); alive = true; } catch { /* stale lock */ }
  if (alive && other !== process.pid) { log(`another runner (pid ${other}) is already running; stop it first (npm run demo:up -- --no-runner for the crash clip)`); process.exit(2); }
}
mkdirSync("agent/.cache", { recursive: true });
writeFileSync(LOCK, String(process.pid));
let closing = false;
const unlock = () => { try { if (existsSync(LOCK) && readFileSync(LOCK, "utf8") === String(process.pid)) unlinkSync(LOCK); } catch { /* best effort */ } };
process.on("exit", unlock);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { closing = true; unlock(); process.exit(0); });

const runner = await connect("runner", { onDrop: e => { if (closing) return; log(`lost the database connection${e?.message ? `: ${e.message}` : ""}; exiting`); process.exit(1); } });
await ensurePersona(runner, "runner");
log(`online as runner · identity ${runner.identity!.toHexString().slice(0, 8)} · provider ${PROVIDER_URL} (mock, no funds move)${CRASH ? " · WILL CRASH AFTER ACCEPT" : ""}`);

let running = false, again = false;
async function pass() {
  if (running) { again = true; return; }
  running = true;
  try { await runnerPass(runner, { providerUrl: PROVIDER_URL, crashAfterAccept: CRASH, log }); }
  catch (e) { log(`pass failed: ${String(e)}`); }
  finally { running = false; if (again) { again = false; await pass(); } }
}

await pass();
if (ONCE) { log("pass complete; exiting"); closing = true; runner.disconnect(); process.exit(0); }
log("watching for approved requests");
let timer: NodeJS.Timeout | undefined;
const schedule = () => { clearTimeout(timer); timer = setTimeout(pass, 200); };
runner.db.paymentRequest.onInsert(schedule); runner.db.paymentRequest.onUpdate(schedule);
// Poll while anything waits on the provider: settlement of submitted
// transfers, and reconciliation of unknown ones.
setInterval(() => { if ([...runner.db.paymentRequest.iter()].some(r => r.state === "submitted" || r.state === "unknown")) pass(); }, 1000);
