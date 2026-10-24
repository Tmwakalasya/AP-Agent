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

const runner = await connect("runner");
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
if (ONCE) { log("pass complete; exiting"); runner.disconnect(); process.exit(0); }
log("watching for approved requests");
let timer: NodeJS.Timeout | undefined;
const schedule = () => { clearTimeout(timer); timer = setTimeout(pass, 200); };
runner.db.paymentRequest.onInsert(schedule); runner.db.paymentRequest.onUpdate(schedule);
setInterval(() => { if ([...runner.db.paymentRequest.iter()].some(r => r.state === "submitted")) pass(); }, 1000);
