# Remit-To contracts

Implementation requirements for the live system, revised for the solo CalHacks 13.0 build. The offline reference is `module/rules.ts` and its tests. Everything in the tables, reducers and lifecycle sections below is implemented in `module/src/` and exercised by `agent/live.test.ts` against a fresh local database; the acceptance gates name the test that proves each one.

## Positioning

An autonomous AP agent with hard separation of duties. Claude reads the documents and explains; deterministic policy decides; the database enforces who can approve. Proven on freight, where payment-redirect fraud is worst.

## Scope

One USD linehaul obligation per delivered load. A clean invoice becomes a request for human approval. Duplicate billing and a remit-to conflict are held with evidence. Deferred: partial and short payments, release processing, accessorials, general ledger, autonomous personas, scenario generation, live authority lookup, real payment rails.

One builder. No owner table. The schedule is in `docs/plan.html`.

## Invariants

1. One unresolved or paid obligation reserves a load regardless of payee, invoice number, worker, or restart. A normalized carrier/invoice key also blocks the same invoice being attached to another load.
2. Only trusted assignment records select a payee. Extracted remit-to text is compared with that result; it never edits the assignment or bank directory.
3. The requester cannot approve their own request. Another authorized AP lead or controller may approve it within their limit. The agent cannot approve anything.
4. An approval binds an immutable amount, currency, payee, bank destination version, and evidence/policy snapshot digest. Changes before dispatch invalidate the approval.
5. A payment identity (idempotency key) and its exact payload are persisted before a provider call. Restart or uncertainty never creates a new payment identity for the same obligation.
6. A provider-accepted transfer is `submitted`, not settled. An ambiguous response is `unknown`, not `failed` and not permission to pay again. The mock provider's terminal success is `simulated_settled` and is labeled as such everywhere it appears.
7. A refusal preserves business state and produces a committed refusal event. The one logged exception: a claim or approval that finds a stale snapshot returns the request to pending and re-binds it. **Verified on spacetimedb 2.13.0 (TypeScript module, local):** a reducer that inserts an audit row and returns normally commits it; a reducer that inserts and then throws `SenderError` rolls the row back. Refusals therefore write `decision_log` and return; they never throw.
8. Evidence ids must resolve to the appropriate document, carrier, load, and received-at time. An existing but unrelated document is not valid evidence.

## Conventions

- Money is a nonnegative safe integer number of USD cents. Stored as `u64`; converted to `number` at the policy boundary with a safe-integer check. Payments must be positive. No floating-point money.
- Timestamps in fixtures are ISO 8601 UTC strings. Stored as `timestamp`; projected to ISO strings for `rules.ts`. Business policy uses an explicit `as_of`; the reducer uses `ctx.timestamp`.
- World ids use `A-`, `C-`, `F-`, `L-`, `D-` prefixes. Runtime ids are allocated by the module.
- Invoice numbers are trimmed, repeated whitespace collapsed, uppercased.
- Rules and explanations cite the same ids. A rationale describes the structured decision; it cannot change it.
- The module derives the actor from `ctx.sender`. Demo personas are bound by first claim (`bootstrap_persona`), never by an `acting_as` argument. Persona tokens are confined to the disposable local demo.
- `rules.ts` is imported unchanged by the agent (to explain) and by the module (to decide). One policy, two call sites.

## Live tables (11)

| Table | Content and constraints |
| --- | --- |
| `actor` | `identity` (unique), `id`, `role` (`agent` / `ap_lead` / `controller` / `runner` / `world`), `approval_limit_cents`, `persona` label. Bound only by `bootstrap_persona`. `world` seeds and attaches documents; it cannot approve or pay. |
| `carrier` | id, name, authority (`active` / `revoked`), verified bank destination version. |
| `factor` | id, name, verified contact, bank destination version. |
| `assignment` | carrier, factor, effective_at, source NOA document id, released_at (null), verified_by. Only verified rows influence payment. |
| `load` | id, carrier, delivered, rate_cents, rate document id, POD document id. The seed cannot mark a load paid. |
| `document` | id, kind, carrier, load (nullable), sender, received_at, content hash, path. Immutable once received. |
| `extraction` | document id, content hash, typed invoice fields, confidence, model/prompt version, Claude explanation text. Cannot activate assignments. |
| `settlement` | load, invoice document, normalized invoice number, agreed amount, policy payee, decision, rule results, evidence ids, snapshot digest, drafted escalation email. |
| `payment_request` | id, `load_id` (unique), `invoice_key` (unique, carrier + normalized number), immutable amount/currency/payee/bank version/snapshot digest, requested_by, state, idempotency key, frozen payload, transfer id (unique, optional), last outcome. |
| `approval` | request id, snapshot digest, approver identity, decision, reason, time. |
| `decision_log` | id, actor, operation, outcome (`ok` / `refused` / `reserved` / ...), reason, rule results, evidence ids, load/request ids, time. Append-only. |

Dropped from the earlier draft: `question`, `sim_clock`. Claude drafts the escalation email from the structured hold; there is no question/answer loop.

## Reducers

| Reducer | Caller | Behavior |
| --- | --- | --- |
| `bootstrap_persona(role)` | any unbound identity | First-claim binding of `ctx.sender` to a seeded persona of that role; refused if the sender is already bound or the persona is taken. |
| `seed_world` | controller, world | Three stories plus two filler clean loads, the March NOA assignment, all documents. Idempotent; refused if already seeded. |
| `attach_document_file` | controller, world | Records the content hash and rendered path of a seeded document. Re-attaching the same hash is a no-op; a different hash is refused because received evidence is immutable. |
| `update_carrier_bank` | controller | Bumps a carrier's verified bank destination version (or marks a change pending). Every pending or approved request to that carrier returns to pending and is re-bound to the new version, so it needs a new approval; while a change is pending, R8 holds it and no approval can bind. |
| `record_extraction` | agent | Typed fields for an existing document hash. Cannot touch assignments. |
| `propose_settlement` | agent | Re-runs `evaluateSettlement` on trusted rows; writes `settlement` and `decision_log`. |
| `request_payment` | agent, ap_lead | Re-checks policy; inserts `payment_request` whose unique `load_id` and `invoice_key` indexes form the atomic reservation. A refusal commits a `decision_log` row and makes no business mutation. |
| `approve_payment` / `reject_payment` | ap_lead, controller | `checkApproval` with the actor from `ctx.sender`; the submitted snapshot digest must match the stored one. Rejection needs a reason. |
| `claim_payment` | runner | Moves one `approved` request to `submitting`; persists the idempotency key and frozen payload first. Re-checks the snapshot against trusted rows. |
| `record_payment_outcome` | runner | Idempotent transitions to `submitted`, `unknown`, `failed`, `simulated_settled`. Never accepts a transfer against an unrelated request. |

## Payment lifecycle and recovery

```text
pending -> approved -> submitting -> submitted -> simulated_settled
   |          |            |            |
rejected   pending*     unknown       failed
                           |
                  submitted / failed
```

`pending*`: the prior approval is invalidated when the snapshot changes before dispatch; the request is re-bound to the current trusted rows and needs a new approval. Only the runner may report provider outcomes. Rejected and failed requests keep their reservation until a controller reconciles them.

1. `request_payment` atomically creates the request and both reservations. Two simultaneous requests for one load leave one reservation and at most one executable request, even with different payees.
2. Approval records the exact snapshot. `claim_payment` re-checks it against current trusted rows, then freezes the payload.
3. The runner sends the frozen payload outside the transaction using the stored key. No new key per attempt, restart, or timeout.
4. Provider acceptance records `submitted`. Duplicate notifications for the same transfer are no-ops apart from audit. The mock's terminal success records `simulated_settled`.
5. A timeout or crash after a possible send leaves the obligation reserved. On restart the runner looks up the stored key at the provider and reconciles.
6. If the provider cannot resolve the key, hold for controller reconciliation. No blind retries.

**Provider:** `agent/mock-provider.ts`, an in-process HTTP server with an idempotency map, latency, a `crash_after_accept` flag and a lookup endpoint. It is labeled as a mock in the UI, the landing page and the video. There is no real bank or sandbox integration.

## Rules and policy numbers

Explicit demo policies, not a statement of law or universal freight practice.

| Id | Rule | Failure behavior |
| --- | --- | --- |
| R1 | Linehaul within 100 cents of the agreed rate; payment uses the agreed amount. | Hold; no automatic short payment. |
| R2 | One verified assignment effective by invoice date selects its factor; none selects the carrier. Requested remit-to cannot change this. | Hold and draft an email to the factor/controller. Multiple assignments or releases are held. |
| R3 | An unresolved or paid reservation blocks the same load or normalized carrier/invoice number, regardless of payee. | Hold the duplicate; keep the original obligation. |
| R6 | Delivered load and a valid POD for that carrier/load. | Hold. |
| R7 | Invoice, load and carrier identifiers agree. | Hold. |
| R8 | No unresolved bank change. | Hold for a callback; the model cannot assert verification. |
| R9 | Seeded carrier authority is active. | Hold. |
| R10 | USD linehaul, valid timestamps/amounts, summed totals, nonempty invoice number, known evidence, confidence at least 0.95. | Hold. |

AP approval ceiling: 500,000 cents, further restricted by the actor's limit. Controller limit: configured per actor.

## Evaluation

36 synthetic development cases (24 clean, 6 duplicate, 6 redirect) scored against `world/answer-key.json`, which the agent never reads. This is the evidence slide: 36/36 exact, 0/24 false holds, 0/12 unsafe requests. It is not a blind evaluation, not independent layouts, not a production catch rate. The blind set and the 30–50 live cases from the earlier draft are dropped for this build.

## Acceptance gates

`live` is `agent/live.test.ts` (12 tests, fresh database, five identities). `rules` is `module/rules.test.ts`. `scoring` is `world/scoring.test.ts`.

| Gate | Check | Verified by |
| --- | --- | --- |
| Clean flow | Extract, propose, request as agent, approve as controller, runner moves to `submitted` then `simulated_settled`, live in two tabs. | live: "clean", "runner"; two-tab run on the board |
| Duplicate race | Two concurrent `request_payment` calls for one load: one reservation, one committed refusal. | live: "duplicate race" |
| Cross-load duplicate | Reuse the carrier/invoice key on another load: held. A different carrier's same number: allowed. | rules: "relabeled as another load", "another carrier"; module unique index on `invoice_key` |
| Redirect | June request conflicts with verified March NOA: held, factor remains policy payee, NOA visible, escalation email drafted. | live: "redirect"; rules: "June redirect" |
| Approval | AP self-approve refused. Agent approve refused by role. Controller approves. | live: "separation of duties"; rules: three approval tests |
| Stale approval | Change the verified destination before dispatch: the approval is voided, the old digest cannot approve, the re-bound request can, and a pending change is an R8 hold. | live: "stale approval" |
| Crash after accept | Mock accepts; runner killed before `record_payment_outcome`; restart reconciles to one transfer and one `submitted` event. | live: "crash after accept"; `npm run demo:crash` |
| Audit | Business refusal commits a `decision_log` row; business state unchanged; actor is `ctx.sender`. | live: "every refusal in this run"; 2.13 commit/rollback probe |
| Evidence boundary | Wrong-load POD, nonexistent NOA, future evidence, malformed extraction, unknown currency: all hold. | rules: "wrong-load POD", "assignment evidence", "fail closed" |
| Scoring isolation | Agent cannot read expected outputs; missing cases fail. | scoring: all three tests |
