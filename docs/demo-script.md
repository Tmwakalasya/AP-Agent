# Remit-To · demo cue sheet

Two minutes, five beats, one take. Each beat lists what to click, what should appear, and what to say. Say the lines in your own words; the times are targets, not cues.

## Before every take

1. Close every Remit-To tab except the two below. Seats bind to the first browser that opens them, and Vite reloads open tabs on restart.
2. Fresh state: stop `demo:up` (ctrl-c), then run `npm run demo:up`. Wait for `demo is up`.
3. Open the tabs it prints, controller first:
   - controller: `http://localhost:5173/app/?persona=controller&demo&load=L-2041`
   - AP lead: `http://localhost:5173/app/?persona=ap&demo&load=L-2029`
4. Check the right panel on each tab: the badge says **Marcus Obi · Controller** and **Dana Whitfield · AP lead**. If it says "Another browser already holds the … seat", close the extra tab and restart `demo:up`.
5. Check the load list: L-2041 **hold**, L-2037 **pending approval**, L-2037 re-bill **hold**, L-2033 **ready**, L-2029 **ready**.
6. Browser zoom 100%, window at least 1440 px wide, bookmarks bar hidden, notifications off.

Do not, during a take:

- Click **change … bank destination**. It works (the request re-binds to the new bank version and asks you to approve again), but it is not in the script.
- Open a third tab with `?persona=`.

## 1 · Redirect (0:00–0:25) · controller tab, L-2041

| Click | You should see |
| --- | --- |
| (already selected) | Banner **Hold. Pay nobody yet.** "Policy says pay" Meridian Capital Factoring (factor); "Invoice says pay" Ridgeline Transport LLC (carrier), highlighted as a mismatch. |
| R2 check chip | The rule text: the verified assignment requires the factor; invoice or email instructions cannot change it. |
| Evidence strip | NOA marked **cited**, the June 11 email marked **unverified**. |
| "Escalation email · drafted by Claude" | The email to the factor. |
| Right panel | "No request exists. The reducer refused to create one." |

Say: "Ridgeline's invoice and an 'updated banking' email ask us to pay them directly. In March they assigned their receivables to Meridian, and that notice is verified. An unverified email cannot replace a verified payment instruction, so the policy holds it, cites the notice, and Claude drafts the email to the factor. The database will not even create a payment request."

## 2 · Clean, live approval (0:25–0:50) · controller tab, L-2037

| Click | You should see |
| --- | --- |
| **L-2037** (not the re-bill) | **Pending approval. $1,850.00 to Blue Mesa Freight.** Requested by A-agent. All checks pass. |
| **approve** | Steps walk: approved, claimed, submitted, then **settled (mock)** about five seconds later; the banner reads **Settled (simulated).** The idempotency key and mock transfer id appear in the panel. |

Say: "This one matches the rate confirmation and the proof of delivery. The agent requested it, but the agent can't approve anything. I approve as the controller. The approval is bound to this amount, payee and bank version. The payment runner, a separate identity, saved its idempotency key in the database before calling the provider. The provider is a labeled mock; no money moves."

## 3 · Duplicate (0:50–1:10) · controller tab, L-2037 re-bill, then L-2033

| Click | You should see |
| --- | --- |
| **L-2037 re-bill** | **Hold.** "This load already has an obligation (request #1, INV-5521, simulated_settled). This invoice bills it again under a new number." R3 failed. |
| **L-2033** | **Ready. $925.00 to Cascade Haul Co.** Demo controls box on the right (the race button only appears on this load). |
| **race: two agent requests at once** | "database said: request payment ×2 → reserved, refused". The audit column gets a refused row with the reason "already reserved by an existing request". L-2033 goes to **pending approval**. |

Say: "Two weeks later the same carrier bills the same load again under a new number. The load already has an obligation, so it's held. Now the harder case: two workers pick up the same invoice in the same instant. The database runs reducers one at a time, and a unique index on the load is the reservation. One request is reserved; the other is refused, and the refusal is a committed row in the audit log."

## 4 · Separation of duties (1:10–1:35) · AP tab, then controller tab, L-2029

| Click | You should see |
| --- | --- |
| Switch to the **AP lead** tab (L-2029 selected) | **Ready. $3,100.00 to Northstar Logistics.** |
| **request payment** | **Pending approval.** Requested by A-ap. The hint says "You requested this (A-ap). A different person must approve it." |
| **try to approve** | "database said: approve payment → refused · The requester cannot approve their own request." The audit column shows the same refused row with the reason. |
| Switch to the **controller** tab, click **L-2029** | Pending, requested by A-ap. Demo controls show **agent tries to approve #3**. |
| **agent tries to approve #3** | "database said: agent approve payment → refused · Role agent may not call approve_payment." |
| **approve** | Steps walk to **settled (mock)**. |

Say: "Dana, the AP lead, requests this one herself. She tries to approve her own request. The button is live; the database refuses and logs it. The agent tries too, refused by role. None of this is the UI hiding a button: each reducer reads the caller's identity from the connection, never from the client. A different person approves, and it pays."

Request numbers assume this order: #1 L-2037 (agent, at seed), #2 L-2033 (race), #3 L-2029. If you change the order the numbers change; nothing breaks.

## 5 · Evidence (1:35–2:00) · landing page

| Click | You should see |
| --- | --- |
| Open `http://localhost:5173/#evidence` | Scorer numbers and the real / simulated / not built lists. |
| Optional: cut to the crash clip (below) | Runner killed after accept; restart finds one transfer. |

Say: "On thirty-six synthetic fixtures with an answer key the agent never sees: thirty-six exact, zero false holds, zero unsafe requests. Twenty-two offline tests and fifteen live ones against a fresh database, including the race, self-approval and a crash after the provider accepts. Claude reads and explains. The policy decides. The database enforces who may approve."

## Crash clip (record separately, about 10 seconds)

1. Stop `demo:up`, then run `npm run demo:up -- --no-runner`. Open only the controller tab.
2. Controller tab: **L-2037**, **approve**. It stays at **approved** because no runner is running.
3. In a second terminal, in the repo: `npm run demo:crash`.
4. Show the terminal. You should see, in order:
   - `#1: provider accepted mtr_…. CRASH: process killed before record_payment_outcome.`
   - `#1 L-2037: found submitting with stored key rt-1-…; asking provider before doing anything`
   - `#1: provider already holds mtr_… for that key → submitted. Nothing sent again.`
5. Board shows **submitted** with the same transfer id. Restart plain `npm run demo:up` before the next main take.

Say: "Worst case: the provider accepted the payment and we crashed before writing it down. The key was saved first, so the restarted runner asks the provider by key and finds the one transfer. Nothing is sent twice."

## If something goes wrong mid-take

- **Header says "reconnecting in …".** The tab lost SpacetimeDB and will come back on its own, same seat, as soon as :3000 answers. The runner and demo control exit on a drop, so `demo:up` stops too; restart it (`npm run demo:up`) and the tabs recover without a refresh.
- **Board says "Not connected".** SpacetimeDB was down when the tab loaded. Restart `demo:up`; it starts `spacetime` if :3000 is free. The tab retries by itself.
- **A check you opened closed by itself.** It should not any more; the open state is kept while the row stays the same. Switching rows resets it, which is expected.
- **Race or agent-approve says "Demo control is not running".** `demo:up` was started in a way that skipped it, or it crashed. Restart `demo:up`.
- **Approve does nothing for a few seconds.** The runner is off (`--no-runner`) or crashed. Check the `runner │` lines in the `demo:up` output.
- **Anything else.** Stop, restart `demo:up`, reopen the two tabs, start the take again. A restart takes about fifteen seconds.
