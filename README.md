# Remit-To

Remit-To checks who should be paid, catches conflicting instructions, and shows the evidence before payment. The target user is the carrier-settlement or AP lead at a small freight brokerage. The first demo covers **a clean invoice, a duplicate, and a payment redirect conflicting with an earlier factoring assignment**.

## Run the groundwork

Requires Node 22.18+ with native TypeScript support. No install, credentials, network access, or `.env` file is needed for these commands:

```sh
npm test
npm run demo
npm run score
```

The demo evaluates synthetic extracted records, shows evidence and hold reasons, and demonstrates AP self-approval rejection followed by permission for a different controller. The scorer compares 36 development cases (24 clean, 6 duplicate, 6 redirect) against an explicit answer key. A nonmatching result exits with failure.

**Implemented:** a deterministic, dependency-free policy core; approval checks; synthetic fixtures; an exact-result scorer; and boundary tests. The TypeScript files run through Node's type stripping. This is runtime verification, not a TypeScript compiler check.

**Not implemented:** document extraction, authenticated reducers, durable reservations, Spacetime subscriptions, the UI, or a payment-provider integration. No funds move. The duplicate check reads supplied reservations; concurrency safety requires the future reducer to check and reserve in one transaction. A high score on these synthetic records does not measure extraction quality or real-world fraud detection.

## Read in this order

1. [Build plan](docs/plan.html): scope, gates, demo, and fallback.
2. [Contracts](CONTRACTS.md): rules, authority, payment recovery, and integration acceptance checks.
3. [Policy core](module/rules.ts): `evaluateSettlement` and `checkApproval`.
4. [Fixtures](world/fixtures.ts) and [tests](module/rules.test.ts): concrete flows and failure cases.

| Folder | Current content | Next integration task |
| --- | --- | --- |
| `module/` | Pure policy and approval checks, tests | Authenticated reducers and durable payment reservations |
| `agent/` | Reserved for the live worker | Validate extraction against source documents; call reducers using the agent identity |
| `world/` | Synthetic fixtures, explicit answer key, CLI demo and scorer | Render a few documents; replay only facts visible at the chosen sim time |
| `web/` | Reserved for the live UI | Board, evidence detail, approval panel; scoreboard can be a small summary |

`CONTRACTS.md` describes the proposed live system. The offline types in `module/rules.ts` are a policy input projection, not a database schema or public service API. Adapt trusted database records into that input; never trust a client's claimed role, reservation list, assignment, bank-change flag, or approval snapshot.

The full stack remains TypeScript, SpacetimeDB, Claude, and optionally the Increase sandbox. Version selection, dependency installation, external documentation checks, and API calls are separate integration work. `.env.example` is only for that later work; use sandbox credentials and keep `.env` untracked.

The proposed Hyphenate and Spacetime track fit, event timing, and domain policy still need confirmation. Nothing has been deployed, committed, or pushed as part of this groundwork.
