# Remit-To

**Pay the right party. Prove it.**

Remit-To is an accounts-payable agent for freight brokers. It reads carrier invoices, checks them against delivery evidence and verified payment instructions, and prepares payments for approval by a different person.

Claude extracts and explains. Deterministic policy decides. SpacetimeDB enforces permissions, reservations, and payment state.

Built for **Cal Hacks 13.0** with TypeScript, Claude, SpacetimeDB, Node.js, and Vite. **All data is synthetic. The payment provider is a labeled mock; no funds move.**

## What it demonstrates

| Scenario | Decision |
| --- | --- |
| **Payment redirect** | A carrier requests direct payment despite a verified assignment to a factoring company. The agent holds the invoice, cites the assignment, and drafts an escalation email. |
| **Duplicate invoice** | A second invoice bills an already-reserved load under a new number. It is held. Concurrent requests also produce one reservation and one recorded refusal. |
| **Clean settlement** | An invoice matches the agreed rate and delivery evidence. A different authorized person approves it, then a separate runner submits it to the mock provider. |

The board shows the evidence, policy checks, approval identity, and audit trail for each decision. A read-only version updates live on the landing page.

## Architecture

```text
Invoice PDFs → Claude extraction → Shared policy → SpacetimeDB reducers
                                                       │
                                   ┌───────────────────┼───────────────────┐
                                   ▼                   ▼                   ▼
                             Live board          Human approval      Decision log
                                                       │
                                                       ▼
                                                 Payment runner
                                                       │
                                                       ▼
                                                 Mock provider
```

The agent and database import the same [policy module](module/rules.ts). Reducers recompute decisions from stored records and derive each caller's role from the connection identity.

- **Separate duties:** the agent cannot approve payments, and a requester cannot approve their own request.
- **Reserve obligations:** unique load and carrier/invoice keys prevent duplicate requests.
- **Validate evidence:** the extracted load reference must match the load. Approval binds the typed invoice facts, amount, payee, and bank version.
- **Invalidate stale approvals:** relevant corrections require another approval. Changing the invoice identity retains the original reservation and holds the request for reconciliation.
- **Recover safely:** the runner persists its idempotency key and exact payload before dispatch. After a crash, it reconciles with the provider using that key.
- **Keep an audit trail:** business refusals commit an event without creating a payment. Each provider transfer belongs to one request.

```text
pending → approved → submitting → submitted → simulated_settled
```

An ambiguous provider response is `unknown`; the obligation stays reserved. Provider acceptance is `submitted`, not settlement.

## Quick start

### Requirements

- Node.js **22.18+**
- SpacetimeDB CLI **2.13+**
- Google Chrome for rendering the demo documents; set `CHROME` if its executable is not at the default macOS path
- An Anthropic API key for Claude extraction and explanations, or the labeled manual fallback

Install dependencies and configure the optional API key:

```sh
npm ci
npm ci --prefix module
cp .env.example .env
```

Set `ANTHROPIC_API_KEY` in `.env` to enable Claude. Without a key, extraction uses manual fixture data and explanations use templates; both are labeled in the board. Claude results are cached locally by content and prompt/model version.

Start the demo:

```sh
npm run demo:up
```

This command starts the local database if needed, publishes a fresh module, renders and seeds the documents, runs the agent, and starts the web app, mock provider, payment runner, and demo controls.

**The default command resets the demo database and mock transfer log.** Stop an existing demo before running it again. To resume an existing compatible database without reseeding:

```sh
npm run demo:up -- --no-reset
```

Open the controller tab first, then the AP lead tab:

- [Controller](http://localhost:5173/app/?persona=controller&demo&load=L-2041)
- [AP lead](http://localhost:5173/app/?persona=ap&demo&load=L-2029)
- [Landing page](http://localhost:5173/)

The services use ports `3000`, `4310`, `4311`, and `5173`. Press **Ctrl+C** to stop processes started by the demo command. Follow the [two-minute demo guide](docs/demo-script.md) for the presentation sequence and recovery clip.

> **Updating an older demo:** the extraction schema now requires `load_reference`. Restart with the default `npm run demo:up` to reset and reseed before using the regenerated clients. Existing demo data is not migrated.

## Verification

The policy tests and scorer run without dependencies, API keys, or network access:

```sh
npm test
npm run demo
npm run score
```

For the live suite, start `spacetime start` in a separate terminal and stop the demo services. These commands reset local demo data:

```sh
npm run reset
npm run test:live
```

| Check | Result |
| --- | --- |
| Offline policy and scoring tests | **22 passed** |
| Live integration tests | **15 passed**, including approval invalidation, transfer ownership, duplicate races, and crash recovery |
| Synthetic development scorer | **36/36** exact decisions; **0/24** false holds; **0/12** unsafe requests |

The scorer evaluates policy against typed synthetic fixtures. It does **not** measure document extraction accuracy or production fraud detection, and it is not a blind benchmark. Live tests use manual extraction inputs and the mock provider.

Build the web app and database module separately:

```sh
npm run build
npm run build --prefix module
```

## Scope and limitations

The prototype supports one USD linehaul obligation per delivered load. Carrier authority, verified assignments, bank verification, and document associations are seeded. Claude reads the invoice PDFs; supporting rate, delivery, and assignment facts come from that seeded state. Persona binding is a convenience for a disposable local demo, not production authentication.

Real payment rails, live authority lookup, assignment-release processing, accessorials, partial payments, general-ledger integration, policy learning, and a reconciliation workflow are outside this build. Rejected, failed, and uncertain requests retain their reservations.

## Explore the implementation

1. [Contracts and acceptance gates](CONTRACTS.md) — the guarantees and how they are tested.
2. [Policy](module/rules.ts) — settlement decisions and approval checks.
3. [Database reducers](module/src/index.ts) — identity checks, reservations, snapshots, and state transitions.
4. [Agent worker](agent/worker.ts) — extraction, explanations, and payment requests.
5. [Live tests](agent/live.test.ts) — the complete workflow and failure cases.

The [demo guide](docs/demo-script.md) covers presentation and troubleshooting. The [build plan](docs/plan.html) records the original scope and schedule. Generated client bindings live in `bindings/`, the Vite app in `web/`, and synthetic fixtures and document rendering in `world/`.
