# Remit-To contracts

Revised draft for a three-scenario demo. These are implementation requirements for the live system; they are not a claim that the database, authentication, or payment runner already exists. The offline reference is `module/rules.ts` and its tests.

## Scope and ownership

The first slice supports a single USD linehaul obligation per delivered load. A clean invoice becomes a request for human approval. Duplicate billing and a remit-to conflict are held with evidence. Partial payments, automatic short payments, release processing, accessorial adjudication, full accounting, autonomous personas, and arbitrary scenario generation are deferred.

| Owner | Owns | Must agree with |
| --- | --- | --- |
| B: state and controls | Trusted records, authenticated reducers, payment reservations, runner | C on policy; D on status and evidence |
| C: extraction and decisions | Typed extraction, deterministic policy, evidence explanation | A on documents; B on reducer inputs |
| A: scenarios and evaluation | Fixtures, source documents, replay, explicit expectations | C on extraction fields; B on ingestion |
| D: UI and demo | Board, evidence detail, approvals, recorded demo | B on subscriptions and identity |

With two people, combine B+C and A+D and use the offline payment fallback. The first integrated decision is due by hour 6, not hour 18.

## Invariants

1. One unresolved or paid obligation reserves a load regardless of payee, invoice number, worker, or restart. A normalized carrier/invoice key also blocks the same invoice being attached to another load.
2. Only trusted assignment records select a payee. Extracted remit-to text is compared with that result; it never edits the assignment or bank directory.
3. The requester cannot approve their own request. Another authorized AP lead or controller may approve it within their limit. The agent cannot approve anything.
4. An approval binds an immutable amount, currency, payee, bank destination version, and evidence/policy snapshot. Changes before dispatch invalidate the approval.
5. A payment identity and its exact payload are persisted before a provider call. Restart or uncertainty never creates a new payment identity for the same obligation.
6. A provider-accepted transfer is `submitted`, not `settled`. An ambiguous response is `unknown`, not `failed` and not permission to pay again.
7. A refusal preserves business state and produces a committed refusal event. An unexpected transaction abort is a technical failure; do not claim its audit write survived.
8. Evidence ids must resolve to the appropriate document, carrier, load, and available-at time. An existing but unrelated document is not valid evidence.

## Conventions

- Money is a nonnegative safe integer number of USD cents in the TypeScript reference. The live storage representation must preserve that range exactly. Payments must be positive. No floating-point money.
- Timestamps in fixtures are ISO 8601 UTC strings with seconds and optional three-digit milliseconds. Business policy uses an explicit `as_of` time. Transport timeouts use wall time. Invalid or future business facts are held.
- World ids use `A-`, `C-`, `F-`, `L-`, and `D-` prefixes. Live runtime ids are allocated by the module. A persisted demo-run id namespaces payment keys; restarting a worker does not change it.
- Invoice numbers are trimmed, repeated whitespace collapsed, and uppercased. Do not remove punctuation or infer that two different invoice numbers refer to different obligations.
- Rules and explanations cite the same ids. A rationale can only describe the structured decision; it cannot change it. Rendering an existing id is not proof the cited document supports a statement.
- The module derives the actor from the authenticated sender. The role picker uses separate seeded demo identities; it is never an `acting_as` parameter. Persona tokens are confined to the disposable local demo.

## Minimal live records

This replaces the broad initial schema as the MVP target. Final Spacetime field syntax and indexes are chosen after the local version is confirmed. `ReviewInput` is the offline projection of these records, not the wire schema.

| Record | Required content and constraints |
| --- | --- |
| `actor` | Unique identity, id, role, approval limit, simulated flag. Only bootstrap/admin binds identities. |
| `carrier`, `factor` | Known ids, carrier authority, verified contact and bank destination version. Bank edits belong to the controller. |
| `assignment` | Carrier, factor, effective date, source NOA, verification actor/time. Only verified records influence payment. Conflicting assignments and any release are held in the MVP. |
| `load`, `rate_confirmation` | Carrier, delivered status, agreed USD linehaul, source rate document, POD reference. The world loader cannot mark a load paid. |
| `document` | Id, kind, carrier/load association, source sender, received time, content hash and stored bytes/path. Received content is immutable; a path alone does not guarantee this. |
| `extraction` | Document/hash, typed fields, model/prompt version, confidence, validation result. Preserve the original; extraction cannot activate an assignment. A cache key includes content and extraction versions. |
| `settlement` | Load, invoice document and normalized number, agreed amount, policy payee, decision, rule results, evidence ids and snapshot digest. Requested revisions are immutable. |
| `payment_request` | Id, unique obligation key, unique carrier/invoice reservation key, immutable amount/currency/payee/bank version/snapshot, requester, state, provider idempotency key, unique optional transfer id, last provider outcome. |
| `approval` | Request and snapshot digest, authenticated approver, decision, reason, time. Pending requests only; self-approval prohibited. |
| `decision_log` | Invocation id, actor, operation, outcome, structured rule results, evidence ids, request id, sim time. Append-only. |
| `question` | Load, failed rule, addressee, text, deadline, answer and answering actor. One open question per load/rule; only the addressee answers. |
| `sim_clock` | Current time and selected fixture step. Manual stepping is sufficient initially; scheduled advancement is optional. |

Keep the evaluation answer key outside the database reads available to the agent. Full `journal_entry`, `journal_line`, `period`, GPS streams, and free-text `scenario` tables are deferred. The MVP has a payment audit trail, not a general ledger.

## Reducer boundaries

Names describe proposed responsibilities; they are not SDK implementations yet.

| Operation | Caller | Required behavior |
| --- | --- | --- |
| `seed_world`, `ingest_document`, `mark_delivered` | World identity | Known entities only; immutable received evidence; cannot set approval or payment status. |
| `record_extraction` | Agent | Validated fields for an existing content hash; cannot mutate original evidence or activate assignments. |
| `record_assignment` | Controller; world during fixture bootstrap | Verify known carrier/factor and NOA relationship. Extracted email claims are insufficient. |
| `propose_settlement` | Agent | Recompute amount/payee from trusted state; require correct evidence relationships; hold unsupported cases. |
| `request_payment` | Agent, AP lead | Recheck policy and atomically reserve both load and carrier/invoice keys. Pending and uncertain transfers block duplicates too. |
| `approve_payment`, `reject_payment` | AP lead, controller | Use sender identity, enforce separation and limits, require current snapshot. Rejection needs a reason. |
| `claim_payment` | Payment runner | Atomically move one current, approved request to `submitting`; persist key and exact payload before external work. Competing runners cannot independently claim it. |
| `record_payment_outcome` | Payment runner | Match request, key, payload and transfer identity; apply permitted transitions idempotently. Never accept arbitrary transfers against unrelated requests. |
| `ask`, `answer` | Agent asks; addressee answers | Existing load and deadline; no duplicate open question for the same rule. |
| `set_clock` | Controller/demo operator | Step a fixture or advance time; never move backward over recorded payments. |

Expected refusals must commit a refusal event without business mutations and return a normal refusal outcome. Throwing an error that aborts the transaction is not a way to persist that event. Verify the chosen Spacetime version's exact behavior in an integration test.

## Payment lifecycle and recovery

```text
pending -> approved -> submitting -> submitted -> settled
   |           |             |            |
rejected    pending*       unknown       failed
                             |
                   submitted / failed
```

`pending*` requires invalidating the prior approval when its snapshot changes before dispatch. A provider may also return a definitive failure directly from `submitting`. Only the runner may report provider outcomes. Rejected and failed requests keep their reservation until a controller reconciles them; automated reissue is outside the MVP.

1. The reducer atomically creates the request and reservations. Two simultaneous requests for one load must leave one reservation and at most one executable request, even with different payees.
2. Approval records the exact snapshot. Before claiming, the runner's reducer rechecks it against current trusted records. Once claimed, the payload is frozen; bank or payee changes cannot redirect the in-flight transfer.
3. The runner sends the frozen payload outside the transaction using the stored provider key. No new key is generated per attempt, restart, or timeout.
4. A response identifying an accepted transfer records `submitted`. Duplicate notifications for the same transfer are no-ops apart from audit. Only an authoritative terminal success records `settled`; sandbox simulation must be labeled.
5. A timeout or crash after a possible send leaves the obligation reserved. Reconcile the existing key/transfer. Reissue the same key and payload only if verified provider semantics permit it. Never infer failure from a timeout or replay with a fresh key.
6. If the provider cannot resolve the key or its idempotency window has expired, hold for controller reconciliation. Do not add blind retries. Cancellation or changing a payee cannot undo a transfer already accepted by the provider.

Provider idempotency guarantees, lookup endpoints, retention windows, and sandbox status semantics are **unverified integration prerequisites**. Do not implement them from guesses. If they cannot be verified in time, show `simulated_settled` in a visibly separate offline mode; never display a fake provider id or describe it as a real transfer.

The offline policy core does not exercise this lifecycle. The release gate for the live runner is the restart/fault test below.

## Rules and policy numbers

These are explicit demo policies awaiting domain validation, not a statement of law or universal freight practice. In particular, real assignment coverage may depend on more than invoice date.

| Id | MVP rule | Failure behavior |
| --- | --- | --- |
| R1 | Linehaul is within 100 cents of the agreed rate; proposed payment uses the agreed amount. | Hold any larger mismatch; no automatic short payment. |
| R2 | One verified assignment effective by invoice date selects its factor; no assignment selects the carrier. A requested remit-to mismatch cannot change this. | Hold and ask the factor/controller. Multiple assignments, releases, or invalid assignment evidence are unsupported and held. |
| R3 | An unresolved or paid reservation blocks the same load or normalized carrier/invoice number, regardless of payee. | Hold the duplicate; retain the original obligation. |
| R4, R5 | Detention and lumper adjudication are deferred. | Accessorials currently fail R10 rather than being silently paid or denied. |
| R6 | Delivered load and a valid POD for that carrier/load are required. | Hold; request the missing evidence. |
| R7 | Invoice, load and carrier identifiers agree. | Hold. This is an identity consistency check, not a complete double-brokering detector. |
| R8 | No unresolved bank change. | Hold for a callback to a trusted contact; the model cannot assert callback verification. |
| R9 | Seeded carrier authority is active. | Hold. Live authority lookup is deferred. |
| R10 | USD linehaul, valid timestamps/amounts, summed totals, nonempty invoice number, known evidence and confidence at least 0.95. | Hold unsupported or invalid input. Confidence is a review trigger, not a correctness guarantee. |

AP approval ceiling: **500,000 cents ($5,000)**, further restricted by that actor's configured limit. Controller limit: explicit configuration; the offline demo uses the maximum safe integer. Partial payments and agent journal entries are absent. The live extraction adapter validates shape before invoking the typed core and uses a controller hold for malformed output; it must not use type assertions as runtime validation.

The offline reference checks document metadata, not the contents of PDF bytes or a sender's authenticity. The live ingestion and extraction path must establish those relationships; tests using fixture metadata are not evidence that OCR or fraud detection works.

## Fixtures and evaluation

Current executable fixtures: **36 development cases**, comprising 24 clean, 6 duplicate, and 6 redirect cases. They use hand-specified extracted facts with parameter variations, not 36 independent document layouts. `world/answer-key.json` contains one explicit expected decision, amount, payee and failed rule for every case. Missing, extra, or repeated cases fail scoring; there is no default-clean assumption.

The agent/policy does not import the answer key. The offline driver evaluates the case first and sends only the result to the scorer. The future extraction worker receives document bytes and authorized company facts, never expected outcomes or scenario labels.

For the live demo, start with a few rendered documents, then 30–50 cases only after the three stories work. Freeze the policy before a teammate authors 6–12 unfamiliar document variants. Keep that evaluation set separate from development and do not tune against it. Record authorship and any manual adjudication. The existing development set is not a blind evaluation.

Report exact decision/payee/amount agreement, false holds on clean cases, and unsafe requests on exception cases, with counts and denominators. Extraction errors are separate from policy errors. Do not report real dollars saved or production catch rates from planted scenarios. Payment latency is measured only after the asynchronous live path exists and uses an explicit denominator for unpaid cases.

## Integration acceptance gates

| Gate | Observable acceptance check |
| --- | --- |
| Clean flow | Ingest one invoice and POD, extract, match, request, approve as another identity, show the evidence. A controller approving an agent request succeeds. |
| Duplicate race | Two simultaneous requests for the same load, with different invoice numbers/payees, produce one reservation and at most one executable request. |
| Cross-load duplicate | Reuse the normalized carrier/invoice number on another load; it is held. A different carrier's unrelated invoice number is allowed. |
| Redirect | A June request conflicts with a verified March NOA; it is held, the factor remains the policy payee, and the NOA is visible. |
| Approval | AP creates a request and tries to approve it: refused. A different eligible controller approves. An agent approval attempt is also refused, for its role. |
| Stale approval | Change verified destination or evidence before claiming; old approval cannot dispatch. |
| Crash after send | Provider accepts transfer; kill runner before local acknowledgement; restart with the same database. Reconcile to one provider transfer, preserve the reservation, and do not duplicate the payment event. |
| Ambiguous failure | Force a timeout with unknown provider result. UI shows unresolved state and blocks another payment until reconciliation. |
| Settlement status | Accepted is shown as submitted. Only terminal sandbox success is shown as settled; terminal failure remains unpaid. |
| Audit | Force a business refusal and confirm its event is committed while business state remains unchanged. Test actual sender identity, not an injected role string. |
| Evidence boundary | Wrong-load POD, nonexistent NOA, future evidence, malformed extraction and unknown currency all hold. |
| Scoring isolation | Agent cannot read expected outputs; missing cases fail; intentionally wrong payee and false hold are counted. |

## Decisions still needed at kickoff

- Confirm team owners, sponsor fit, eligible tracks, event timing and submission deadline.
- Ask a domain reviewer to challenge invoice-date assignment policy, release scope, and the handling of conflicting instructions.
- Confirm installed Spacetime/SDK versions and supported transaction/auth/subscription APIs before creating the live module.
- Verify provider semantics above before enabling sandbox dispatch.
- Validate buyer interest: ask brokerage AP staff for recent examples, exception frequency, handling time, and workflow integration needs. Ask for anonymized samples only with permission. A demo score does not establish willingness to pay.
