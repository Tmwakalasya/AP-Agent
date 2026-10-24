# Remit-To

**Pay the right party. Prove it.**

An autonomous accounts-payable agent with hard separation of duties. Claude reads the documents and explains; deterministic policy decides; the database enforces who can approve. Proven on freight, where payment-redirect fraud is worst.

Built solo at Cal Hacks 13.0 (October 2026). Tracks: Hyphenate (Autonomous Systems for Finance), SpacetimeDB, Overall / Most Technically Advanced. No funds move.

## The three stories

| Story | What happens | Result |
| --- | --- | --- |
| **Redirect** | A June invoice and an "updated banking" email ask us to pay the carrier directly. A verified March notice of assignment routes payment to a factor. | **HOLD**, rule R2. Factor stays the policy payee. NOA shown. Escalation email drafted. |
| **Duplicate** | A second invoice for an already-requested load arrives under a new number. Two requests race. | **HOLD**, rule R3. One reservation; the loser's refusal is a committed audit row. |
| **Clean** | Invoice matches rate con and POD. | Agent requests; a different human approves; runner submits with a persisted idempotency key. `submitted`, then `simulated_settled`. |

## Layout

| Folder | Content |
| --- | --- |
| `module/` | SpacetimeDB TypeScript module (`src/`) and the policy core `rules.ts` it shares with the agent. |
| `agent/` | Agent worker (Claude extraction, explanation, reducer calls), mock payment provider, payment runner. |
| `web/` | Vite app: landing at `/`, live board at `/app`. `web/mockup/` is the static landing design. |
| `world/` | Synthetic fixtures, answer key, offline demo and scorer. |
| `docs/` | Build plan. |

## Run the offline groundwork

Node 22.18+ (native TypeScript). No install, keys or network:

```sh
npm test        # 22 policy and scoring tests
npm run demo    # three stories through the policy core
npm run score   # 36/36 against the explicit answer key
```

## Run the live module locally

Requires the `spacetime` CLI (2.13+):

```sh
spacetime start                      # local server on :3000
cd module && npm install
spacetime publish remit-to --server local --yes
spacetime sql remit-to "SELECT * FROM decision_log"
```

## Status

| Component | State |
| --- | --- |
| Policy core, approval checks, tests, scorer | Real |
| SpacetimeDB TypeScript module publishing locally | Real (probe schema; business tables in progress) |
| Refusal-as-committed-event | Verified on 2.13.0: return commits the audit row, throw rolls it back |
| Landing page design | Static mockup at `web/mockup/index.html` |
| Tables, reducers, board, agent, runner | In progress; see `docs/plan.html` for the schedule |
| Payment provider | In-process mock, labeled. No bank, no sandbox. |

## Read in this order

1. [Build plan](docs/plan.html): positioning, schedule, demo script, judge answers.
2. [Contracts](CONTRACTS.md): invariants, tables, reducers, lifecycle, acceptance gates.
3. [Policy core](module/rules.ts): `evaluateSettlement` and `checkApproval`.
4. [Fixtures](world/fixtures.ts) and [tests](module/rules.test.ts).

Never trust a client's claimed role, reservation list, assignment, bank-change flag or approval snapshot. The reducer derives the actor from `ctx.sender` and recomputes policy from trusted rows.
