import { spawn } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { createConnection } from "node:net";

// One command for a clean demo: a fresh database, the world seeded and read
// by the agent, then the mock provider, runner, demo control and web app with
// prefixed logs. Ctrl-C stops everything this script started.
//
//   npm run demo:up                 reset, seed, start
//   npm run demo:up -- --no-reset   keep the database as it is; only start the services

const NO_RESET = process.argv.includes("--no-reset");
const SPACETIME = process.env.SPACETIME_BIN ?? "spacetime";
// The race and the AP lead's own request happen live, so the agent leaves these ready.
const LEAVE_READY = "L-2033,L-2029";
const WEB = "http://localhost:5173";
const TSX = ["--import", "tsx"];

const tty = process.stdout.isTTY;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const COLOR: Record<string, (s: string) => string> = {
  "demo-up": paint(1), stdb: paint(90), reset: paint(90), render: paint(90), seed: paint(35), agent: paint(35),
  provider: paint(33), runner: paint(36), control: paint(32), web: paint(34),
};
const say = (name: string, line: string) => process.stdout.write(`${(COLOR[name] ?? paint(0))(name.padStart(8))} │ ${line}\n`);

const children: ChildProcess[] = [];
let stopping = false;

function pipe(name: string, child: ChildProcess) {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (d: string) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const l of lines) if (l.trim()) say(name, l);
    });
    stream.on("end", () => { if (buf.trim()) say(name, buf); });
  }
}

function run(name: string, cmd: string, args: string[]) {
  return new Promise<void>((ok, fail) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    pipe(name, child);
    child.on("error", fail);
    child.on("close", code => (code === 0 ? ok() : fail(new Error(`${[cmd, ...args].join(" ")} exited with ${code}`))));
  });
}

function start(name: string, cmd: string, args: string[], stdio: StdioOptions = ["ignore", "pipe", "pipe"]) {
  const child = spawn(cmd, args, { stdio });
  pipe(name, child);
  children.push(child);
  child.on("error", e => { say(name, `failed to start: ${e.message}`); shutdown(1); });
  // Ctrl-C reaches the children too; give our own SIGINT handler the first word.
  child.on("exit", (code, signal) => setTimeout(() => {
    if (!stopping) { say(name, `exited (${signal ?? code}); stopping the rest`); shutdown(1); }
  }, 100));
  return child;
}

function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 400);
}
process.on("SIGINT", () => { say("demo-up", "stopping"); shutdown(0); });
process.on("SIGTERM", () => shutdown(0));

const portOpen = (port: number) => new Promise<boolean>(done => {
  const s = createConnection({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); done(true); });
  s.once("error", () => done(false));
});
async function waitForPort(port: number, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await portOpen(port)) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

try {
  for (const [port, what] of [[4310, "mock provider"], [4311, "demo control"], [5173, "web app"]] as const) {
    if (await portOpen(port)) throw new Error(`port ${port} is in use (${what} already running?). Stop it, then rerun.`);
  }

  if (await portOpen(3000)) say("demo-up", "spacetimedb already running on :3000");
  else {
    mkdirSync("agent/.cache", { recursive: true });
    const logFile = "agent/.cache/spacetime.log";
    const fd = openSync(logFile, "a");
    start("stdb", SPACETIME, ["start"], ["ignore", fd, fd]);
    say("demo-up", `starting spacetimedb (log: ${logFile})`);
    if (!(await waitForPort(3000, 30_000))) throw new Error(`spacetimedb did not open :3000 within 30s; see ${logFile}`);
  }

  if (NO_RESET) say("demo-up", "--no-reset: keeping the current database");
  else {
    say("demo-up", "publishing a fresh database (wipes all rows and the mock provider log)");
    await run("reset", "npm", ["run", "--silent", "reset"]);
    const rendered = existsSync("world/out") && readdirSync("world/out").filter(f => f.endsWith(".pdf")).length >= 15 && existsSync("web/public/docs");
    if (!rendered) await run("render", "npm", ["run", "--silent", "render"]);
    await run("seed", process.execPath, [...TSX, "agent/seed.ts"]);
    await run("agent", process.execPath, [...TSX, "agent/worker.ts", `--leave-ready=${LEAVE_READY}`]);
  }

  start("provider", process.execPath, [...TSX, "agent/mock-provider.ts"]);
  start("runner", process.execPath, [...TSX, "agent/runner.ts"]);
  start("control", process.execPath, [...TSX, "agent/demo-control.ts"]);
  start("web", process.execPath, ["node_modules/vite/bin/vite.js", "--strictPort", "--clearScreen", "false"]);
  if (!(await waitForPort(5173, 20_000))) throw new Error("the web app did not open :5173 within 20s");

  const lines = [
    "",
    "demo is up · mock payment provider, no funds move",
    `  controller  ${WEB}/app/?persona=controller&demo&load=L-2041`,
    `  ap lead     ${WEB}/app/?persona=ap&demo&load=L-2029`,
    `  landing     ${WEB}/`,
    "  1 L-2041  redirect held (R2), NOA and escalation email",
    "  2 L-2037  agent requested; controller approves; runner settles (simulated)",
    "  3 L-2037 re-bill held (R3); L-2033 race from the controller's demo controls",
    "  4 L-2029  AP lead requests, self-approve refused, agent approve refused, controller approves",
    "ctrl-c stops everything this started",
    "",
  ];
  for (const l of lines) say("demo-up", l);
} catch (e) {
  say("demo-up", `failed: ${(e as Error).message}`);
  shutdown(1);
}
