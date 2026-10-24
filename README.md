# Remit-To

**Pay the right party. Prove it.**

An autonomous accounts-payable agent with hard separation of duties. Claude reads the documents and explains; deterministic policy decides; the database enforces who can approve. Proven on freight, where payment-redirect fraud is worst.

Built solo at Cal Hacks 13.0 (October 2026). Tracks: Hyphenate (Autonomous Systems for Finance), SpacetimeDB, Overall / Most Technically Advanced. No funds move.

## The three stories

| Story | What happens | Result |
| --- | --- | --- |
| **Redirect** | A June invoice and an "updated banking" email ask us to pay the carrier directly. A verified March notice of assignment routes payment to a factor. | **HOLD**, rule R2. Factor stays the policy payee. NOA shown. Escalation email drafted by Claude. |
| **Duplicate** | A second invoice for an already-requested load arrives under a new number. Two requests race. | **HOLD**, rule R3. One reservation; the loser's refusal is a committed audit row. |
| **Clean** | Invoice matches rate con and POD. | Agent requests; a different human approves; runner submits with a persisted idempotency key. `submitted`, then `simulated_settled`. |

Each story is a load on the live board: [L-2041](http://localhost:5173/app/?persona=controller&load=L-2041), [the L-2037 re-bill](http://localhost:5173/app/?persona=controller&load=L-2037:D-inv-5521R), [L-2037](http://localhost:5173/app/?persona=controller&load=L-2037).

## How the pieces split

```text
documents ──▶ agent/worker.ts ──▶ record_extraction ─┐
              (Claude reads,                          │  module/src: reducers re-run
               rules.ts explains)                     ├─ rules.ts on trusted rows,
                                                      │  reserve, log every refusal
browser ──▶ /app  ap_lead | controller ──▶ approve ───┤
                                                      │
agent/runner.ts ──▶ claim ──▶ mock provider ──▶ outcome
```

`module/rules.ts` is one file, imported unchanged by the agent (to explain) and by the module (to decide). The module derives every actor from `ctx.sender`; a client never names its own role. A business refusal writes a `decision_log` row and returns, so the refusal is a committed event, not an exception.

## Layout

| Folder | Content |
| --- | --- |
| `module/` | SpacetimeDB TypeScript module (`src/`), the policy core `rules.ts`, its tests. |
| `agent/` | Agent worker (Claude extraction, explanation, reducer calls), payment runner, mock payment provider, one-command demo runner and demo control, live integration test. |
| `bindings/` | Generated TypeScript client bindings (`spacetime generate`). Committed so the web app and agent build without the CLI. |
| `web/` | Vite app: landing at `/`, live board at `/app/`. `web/mockup/` is the original static design. |
| `world/` | Synthetic fixtures, answer key, document renderer, offline demo and scorer. |
| `docs/` | Build plan, schedule, demo script, judge answers. |

## Run the offline groundwork

Node 22.18+ (native TypeScript). No install, keys or network:

```sh
npm test        # 22 policy and scoring tests
npm run demo    # three stories through the policy core
npm run score   # 36/36 against the explicit answer key
```

## Run the live system

Requires the `spacetime` CLI (2.13+).

```sh
npm install && (cd module && npm install)
cp .env.example .env            # optional: add ANTHROPIC_API_KEY so Claude reads the invoices
```

### One command

```sh
npm run demo:up                  # fresh database, seed, agent pass, then provider, runner, demo control, web
npm run demo:up -- --no-reset    # keep the current database; only start the services
```

It starts `spacetime` if nothing is listening on :3000, refuses to start if :4310, :4311 or :5173 is taken, prefixes every process's log lines, and stops everything on ctrl-c. The agent leaves L-2033 and L-2029 ready instead of requesting them, so the race and the AP lead's own request happen live. Open the two tabs it prints:

```text
/app/?persona=controller&demo&load=L-2041
/app/?persona=ap&demo&load=L-2029
```

`?demo` enlarges the board for recording, widens the audit column with the reason for each refusal, and hides the persona links. On the controller tab, **demo controls** appear for a ready or pending load: *race* sends two `request_payment` calls for the load at the same instant on two agent connections (one reserves, one is refused), and *agent tries to approve* calls `approve_payment` as the agent (refused by role). They go through `agent/demo-control.ts` on :4311, a local process holding the agent token, so the browser never holds it and every outcome is a `decision_log` row.

### By hand

Seven steps, or one terminal with the long-running ones backgrounded.

```sh

spacetime start                  # 1. local server on :3000
npm run reset                    # 2. publish the module fresh, regenerate bindings
npm run render                   # 3. render the invoices, rate cons, PODs, NOA and email to PDF/PNG
npm run seed                     # 4. seed the world, then the agent reads every invoice and proposes
npm run provider                 # 5. mock payment provider on :4310 (labeled; no funds)
npm run runner                   # 6. payment runner, watches for approved requests
npm run dev                      # 7. http://localhost:5173
```

Then open two tabs: `/app/?persona=ap` and `/app/?persona=controller`. `npm run seed` lets the agent request every clean load itself; the controller approves one, and the runner takes it to `submitted` and then `simulated_settled` while both tabs watch. To have the AP lead request a load instead, seed with `npx tsx agent/seed.ts && npx tsx agent/worker.ts --leave-ready=L-2029`. Try approving your own request: the database refuses and the refusal appears in the audit column.

Without an API key the agent runs on a labeled manual fallback (`method=manual` on every extraction). With a key, each document is read once and cached in `agent/.cache/` by content hash, so reseeding costs nothing.

### Resetting between demos

```sh
# stop the runner and provider first (ctrl-c), then:
npm run reset && npm run seed
# restart: npm run provider, npm run runner
```

`reset` wipes the database and the mock provider's transfer log. Personas bind by first claim, so every node process and browser tab rebinds on its next connection; the browser keeps one token per persona in `localStorage`, and the agent, runner and world processes keep theirs in `agent/.tokens/`.

### Proving recovery

```sh
npm run test:live    # 12 live integration tests on a fresh database (run npm run reset first)
npm run demo:crash   # runner dies after the provider accepts; restart reconciles to one transfer
```

### Pointing the board somewhere else

`/app/?host=wss://…&db=remit-to` or `VITE_SPACETIME_HOST` / `VITE_SPACETIME_DB` at build time. Tokens are scoped per target.

## Status

| Component | State |
| --- | --- |
| Policy core (8 rules, 13 checks per invoice, `checkApproval`), 22 offline tests, 36-case scorer | Real. 36/36 exact, 0/24 false holds, 0/12 unsafe requests on synthetic fixtures. |
| SpacetimeDB module: 11 tables, 11 reducers, sender-derived actors | Real, published locally on 2.13. |
| Refusal-as-committed-event | Verified: return commits the audit row, throw rolls it back. |
| Live integration test (`agent/live.test.ts`) | 12/12: redirect, duplicate race, self-approve and agent-approve refused, stale approval, runner transitions, crash-after-accept recovery, every refusal attributed to the real sender. |
| Agent worker | Real. Claude vision reads the rendered PDFs; typed fields match ground truth on all 5 invoices; explanation and escalation email written by Claude from the policy result. Labeled manual fallback without a key. |
| Web app | Real. Landing with live read-only embed; board with decision banner, labeled checks, lifecycle, per-persona tabs, deep links. |
| Payment runner | Real. Idempotency key persisted before dispatch; restart reconciles by stored key. |
| Payment provider | In-process mock, labeled everywhere it appears. No bank, no sandbox. |
| Carrier authority, bank-change verification | Seeded state, not live lookups. |

## Read in this order

1. [Build plan](docs/plan.html): positioning, schedule, demo script, judge answers.
2. [Contracts](CONTRACTS.md): invariants, tables, reducers, lifecycle, acceptance gates.
3. [Policy core](module/rules.ts): `evaluateSettlement` and `checkApproval`.
4. [Module](module/src/index.ts): the reducers that enforce it.
5. [Live test](agent/live.test.ts): the proof, one test per gate.

Never trust a client's claimed role, reservation list, assignment, bank-change flag or approval snapshot. The reducer derives the actor from `ctx.sender` and recomputes policy from trusted rows.
