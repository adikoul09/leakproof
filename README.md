# LEAKPROOF

**A revenue recovery control tower.** Classifies failed Razorpay payments as
*systemic* (a bank or issuer is down) or *idiosyncratic* (this customer's card,
this customer's balance), routes recovery through a policy-gated engine, and
proves **incremental** recovery against a held-out control group — not gross
recovery, which any dunning tool can claim.

Razorpay Buildathon, Track 03.

> The number that matters is not "we recovered ₹67 lakh." It is "₹33 lakh of
> that would not have come back on its own, here is the control arm, here is the
> confidence interval, and here is the hash-chained receipt for every rupee."

---

## Status

| # | Milestone | State |
|---|---|---|
| 1 | Webhook ingestion + failure taxonomy classification | ✅ working end to end |
| 2 | Policy engine (caps, contact window, stop_on, breaker) | ✅ working, 41 tests |
| 3 | One recovery rail end to end (Razorpay Payment Link) | ✅ real links created |
| 4 | Control group + incrementality maths | ✅ validated against a planted effect |
| 5 | Hash-chained audit ledger | ✅ every decision writes a receipt |
| 6 | Synthetic data generator | ✅ seeded, documented, and used to tune the detector |
| 7 | Control Tower dashboard | ✅ queue, KPI strip, decision trace drawer |
| 8 | Replay / what-if engine | ✅ decisions replayed, outcomes modelled and labelled |

---

## Running it

```bash
npm install
cp .env.example .env.local        # fill in the values
npm run db:migrate                # apply Drizzle migrations to Neon
npm run dev                       # http://localhost:3000
npm run inngest:dev               # in a second terminal — the durable job bus
```

If database calls fail with `ENOTFOUND` on a Neon hostname while the rest of the
internet works, your resolver is refusing Neon's per-endpoint subdomains. Set
your machine's DNS to `1.1.1.1`, or use the opt-in escape hatch:

```bash
npm run dev:dnsfix
npm run db:migrate:dnsfix
```

See [FAILURES.md](FAILURES.md) #1.

Seed the live policy and warm the bank-holiday cache:

```bash
npm run db:seed
```

Note: the contact window is 08:00–19:00 IST and bank holidays defer, so outside
those hours the pipeline correctly *defers* rather than sends. `policies/` holds
the reference YAML.

Fill the tower with synthetic traffic:

```bash
npm run simulate                  # 3,000 at-risk events + an injected issuer outage
npm run simulate -- --preset panel   # ~600 events, for a live demo
```

Other scripts: `npm test`, `npm run typecheck`, `npm run db:generate`,
`npm run db:studio`, `npm run db:reset -- --yes` (development only),
`npm run gate -- <event_id>` to print the policy trace for a real event,
`npm run validate:incrementality` to plant a known effect and check the maths
recovers it, `npm run ledger:tamper` to attack the hash chain and watch it
detect the tampering, and `npm run tune:triage` to re-tune the systemic detector
against a known outage (exits non-zero if it misses 0.8 precision / 0.8 recall).

**Demoing to a panel:** generate the big batch *before* anyone is watching. A
3,000-failure batch is ~30,000 events through the real pipeline and ingestion
plus triage takes several minutes. Use `--preset panel` live. Generate on a
working day, too — the contact window is 08:00–19:00 IST and bank holidays
defer, so a batch made on a holiday shows a queue of correctly deferred events
and nothing being sent.

---

## What exists today

### Ingestion

`POST /api/webhooks/razorpay` — public, signature-verified. Fixed order of
operations, and the order is load-bearing:

1. HMAC-SHA256 over the **raw** body (parsing and re-serialising first is the
   classic way to break webhook verification), constant-time compared
2. replay guard on `x-razorpay-event-id`
3. insert the receipt
4. emit onto the Inngest bus
5. return 200

No classification, no policy evaluation, no outbound calls happen in the
handler. Razorpay retries anything slow or non-2xx, so it stays thin —
**≈145ms** on a warm Neon connection, inside the 200ms budget. A request that
has to open a fresh pooler connection costs ≈750ms; keeping the pool warm is a
real deployment concern on Vercel, not a solved one, and it is on the list.

Verified behaviour:

| Case | Response |
|---|---|
| bad signature | `401 INVALID_SIGNATURE` |
| valid | `200 {ok:true, duplicate:false}` |
| same `event-id` again | `409 {ok:true, duplicate:true}` |
| database unreachable | `503 STORAGE_UNAVAILABLE` — so Razorpay retries and nothing is lost |

`POST /api/events/ingest` — the simulator's entry point. It lands on the **same**
pipeline: same rows, same jobs, same classifier. If the generator had its own
code path, the demo would be proving nothing.

### Classification

The intellectual core. Two stages, deliberately separated.

**Stage 1 — taxonomy** (`src/core/triage/taxonomy.ts`, pure). Razorpay's
structured error (`code` / `source` / `step` / `reason`) → a normalised
`failure_class`, with degrading match confidence: exact reason slug (0.95) →
description keywords (0.72) → source/step structure (0.6) → `unknown` (0.5).
`unknown` is a first-class answer, not a bug.

Each class carries a **flavour**: `customer` (this customer's card or balance),
`infra` (a bank, gateway or network), or `indeterminate`.

**Stage 2 — cohort evidence** (`src/core/triage/classifier.ts`, pure). Only
`infra`-flavoured failures can be promoted to systemic, and only if all three
guards pass over a 15-minute rolling window:

- `cohort_n ≥ 16` — small-sample guard
- `decline_rate > baseline + 3σ` (EWMA baseline, α = 0.3)
- `decline_rate > 0.30` absolute floor

Confidence is `logistic(z)` clipped to [0.5, 0.99].

**These thresholds are tuned, not guessed — and tuned across volumes.**
`npm run tune:triage` replays four scenarios through the real classifier and the
real cohort store, sweeps 360 configurations, scores each at its **worst**
scenario, and exits non-zero if the deployed one misses the blueprint's bar of
0.8 precision and 0.8 recall anywhere:

```
demo   3k failures/day, 45-min outage    P 94.2%  R 89.0%   lag 234s
busy   6k failures/day, 90-min outage    P 96.6%  R 93.9%   lag 278s
brief  3k failures/day, 20-min outage    P 84.7%  R 81.3%   lag 326s  ← binds
dense  4k failures/6h,  180-min outage   P 99.3%  R 97.4%   lag 250s
```

On the live 3,049-event demo batch, end to end through the real pipeline:
**precision 83.3%, recall 92.1%**, scoring 100% of the planted ground truth.

Three things the tuning turned up, all stated rather than buried:

- **A single-volume sweep is not tuning.** The first pass tuned at 6k
  failures/day and scored 94.6%; the same thresholds scored 78% on the
  3,000-failure preset the product actually ships, because a thinner corpus
  means smaller cohorts and more small-sample false alarms. The binding case
  turned out to be a *brief* outage in a thin corpus — the most ordinary thing
  that happens to a gateway — and it was not in the original tuning set.
  FAILURES.md #22.
- **Raising the guard and lowering the floor beat doing either alone.** With
  `minCohortN` at 16 carrying the noise problem, the floor no longer has to, and
  the recall a high floor was costing on brief outages comes back. Detection got
  *faster* too.
- **It is really two guards, not three.** Under the seeded prior the σ threshold
  is 0.23, below the 0.30 floor, so the floor always binds first and the σ test
  never changes an outcome. The tuner prints this every run.

Validated between roughly 3,000 and 6,000 failures/day. Below that it is
unvalidated and `minCohortN` is the first thing to lower.

And one thing that got measured and then *not* built: advancing the EWMA
baseline from closed 5-minute buckets — the maintenance the blueprint assigns to
`outage.detect` — drops recall from 97% to **0.8%**. A 5-minute bucket holds ~6
attempts, its observed rate carries a sampling SD near 0.14, and an EWMA has no
idea how many samples each proportion came from, so σ inflates until the 3σ
threshold sits above the outage it exists to catch. The seeded prior wins
because its σ is an assumption rather than a contaminated measurement. The
principled fix is a binomial test that knows `n`; see
[FAILURES.md](FAILURES.md) #11.

A `customer`-flavoured failure **never** becomes systemic no matter how many
arrive together. Ten people short of funds is not an outage, and treating it as
one parks recoverable revenue behind a circuit breaker. Demonstrated: an
`insufficient_funds` payment sitting inside a cohort running at a 60% decline
rate still classifies `idiosyncratic`, while the `issuer_down` payments beside
it classify `systemic / issuer_degraded` at 0.99.

Both stages are pure functions taking every input as an argument — no database,
no clock. That is what lets the replay engine drive the *same* code over a
historical corpus instead of a second implementation that drifts.

**The Payment Downtime API is recorded, never consulted.** `outage.detect`
(cron, every 5 minutes) opens, extends and closes `outage_windows` from the
classifier's own verdicts, then cross-checks each one against Razorpay's feed
and writes the result to `outage_windows.downtime_api_agrees` and
`classifications.downtime_api_agrees`. Feeding it *into* the classifier would
make validating the classifier against it circular — a test asserts `classify()`
contains no reference to downtime data at all.

The verdict is three-valued on purpose. NULL means the feed carried nothing for
this method and had no opinion; `false` means it covered the method and did not
flag this cohort. Collapsing the two would report silence as contradiction.

```
GET  /api/outages                          windows + agreement scorecard
POST /api/outages/detect                   run now instead of waiting for the cron
POST /api/outages/detect?backfill=true     reconstruct windows from a corpus
```

Backfill exists because a generated batch replays a whole day in eight minutes,
so by the time anyone looks the incident is hours old and the live path — which
only looks back far enough to track a stream — correctly finds nothing.

On the demo batch it reconstructs the injected outage cleanly: **HDFC/card, 36
events, 68% peak decline, ₹1,46,968 parked**, alongside five single-event false
positives that match the scorecard's `fp` count.

⚠️ **Agreement currently reads 0 of 6, and that is the correct answer.** The
outage is one the generator injected; Razorpay cannot corroborate an incident
that never happened. Each window records *why* — "feed covers card (4 rows) but
did not flag HDFC". The agreement number only becomes meaningful against real
traffic. See FAILURES.md #24 for the two ways this nearly reported zero for the
wrong reasons.

### The policy gate

`evaluatePolicy(policy, context)` — pure, deterministic, no I/O. Every fact
arrives in the context; it never queries a database, never calls the network,
never reads the clock. Two reasons, both load-bearing:

1. **A policy gate that can time out is not a gate.** If it could make a network
   call, a slow holiday API would decide whether a customer gets contacted.
2. The replay engine drives this exact function over a historical corpus. Any
   hidden input would make replay a different system wearing the same name.

Rules run in a fixed order and short-circuit on the first **block**, so the
trace reads top to bottom as an explanation:

```
circuit_breaker → customer_opt_out → stop_on → max_attempts_per_payment
  → max_contacts_per_customer_per_week → bank_holiday → contact_window
  → max_discount_offered_pct
```

Defers do not short-circuit. A later block still wins over an earlier defer,
because *"we would have waited, but we were never allowed"* is the truthful
answer. `bank_holiday` and `contact_window` **defer rather than block** — the
payment is still recoverable tomorrow, and blocking outright would throw it away
over a calendar accident.

```
$ npm run gate -- pay_TEST00000001 --at "2026-09-10T14:22:00+05:30"

  ✓ circuit_breaker                    expected closed                    actual closed
  ✓ customer_opt_out                   expected false                     actual false
  ✓ stop_on                            expected none of payment_success…  actual none
  ✓ max_attempts_per_payment           expected 3                         actual 0
  ✓ max_contacts_per_customer_per_week expected 2                         actual 0
  ✓ bank_holiday                       expected false                     actual false
  ✓ contact_window                     expected 08:00-19:00 Asia/Kolkata  actual 14:22 Asia/Kolkata
  ✓ max_discount_offered_pct           expected 3                         actual 0

  → ALLOW  allow:contact_window,under_caps
```

The policy YAML is schema-validated at **authoring** time, including the
circuit-breaker trigger expression, which is parsed into a typed comparison at
publish time rather than interpreted live. The gate can therefore never meet a
malformed policy. An unknown `stop_on` value is a 422, not a silent drop — the
dangerous failure would be an operator believing recovery halts on something it
does not.

The breaker is scoped **per cohort** (`HDFC|card`), not globally: one issuer
having a bad afternoon must not halt recovery for every other bank, and a global
breaker is the kind of blunt instrument that gets switched off permanently after
its first false trip.

Endpoints: `GET/POST /api/policies`, `GET /api/policies/:version`,
`POST /api/policies/:version/publish` (archives the previous live version in the
same transaction), `POST /api/breaker/override` (requires a typed reason).
Writes sit behind a bearer `OPERATOR_ACCESS_KEY` until the JWT session lands.

### The recovery rail

The full chain runs end to end against Razorpay test mode:

```
webhook → classify → assign arm → plan (rail + policy gate) → execute → link sent
```

A real run, four events, one shared issuer outage:

| event | arm | rail | chosen by | link | cost |
|---|---|---|---|---|---|
| `pay_M3TEST0004` | **control** | — | — | — | — |
| `pay_M3TEST0005` | naive | `email_link` | `naive_fixed` | `plink_TXhbxFMa9zBWiW` | ₹0.04 |
| `pay_M3TEST0000` | leakproof | `upi_payment_link` | `static_table` | `plink_TXhbxlSXAjRAbY` | ₹0.20 |
| `pay_M3TEST0001` | leakproof | `upi_payment_link` | `static_table` | `plink_TXhbwfIGmVmktP` | ₹0.20 |

The control arm is **held out**: no rail, no policy evaluation, no attempt, no
spend. It stays `at_risk`, which is the honest description of an event we have
deliberately decided not to touch. That is the entire experiment.

**Arm assignment** is `bucket(sha256(event_id + SALT)) % 100` → 18 / 20 / 62.
No stored randomness: given the event id and the salt, the arm is reproducible
forever. That is what lets replay reconstruct the experiment, and what lets an
auditor verify an event was not moved between arms after the fact. The stored
`hash_input` means they can recompute the bucket without being handed the salt
separately. `ARM_ASSIGNMENT_SALT` must never change once events exist.

**Rail routing** is a static table keyed by failure class, ordered by attempt
number, each entry carrying the rationale the Decision Trace shows a human.
An issuer outage routes *around* the issuer (`upi_payment_link`) rather than
retrying into it. An `insufficient_funds` failure schedules a delayed retry
rather than burning an attempt against the cap immediately. A `risk_blocked`
failure is never auto-retried — that is how a merchant account gets flagged.

**Delivery** rides Razorpay's own `notify: {sms, email}` on the Payment Link,
which is why the rail is genuinely end to end without Resend or WhatsApp
provisioned. `reference_id` is the attempt's UUID, which doubles as an
idempotency key: a duplicate is caught, the existing link is fetched, and a
customer can never receive two links for one attempt.

**Execution re-checks everything.** Between planning and execution the customer
may have paid, opted out, complained, or the breaker may have tripped. The job
sleeps durably (`step.sleepUntil`), then rebuilds the policy context and
re-evaluates before sending. Every event carries exactly two `policy_evaluations`
rows — one at plan, one at the execution-time re-check.

Message copy is a static template for now, honestly recorded as
`used_fallback: true`. `composeMessage()` over Gemini slots in behind the same
interface; the LLM boundary stays narrow by design — it receives an
already-approved action and returns copy, and never decides whether to contact,
how much to offer, or when to send.

### The incrementality result ⭐

**This is what the project is judged on.** Gross recovery is not a result: some
failed payments come back on their own, and any dunning tool can claim credit
for those. The only honest question is how many rupees came back *because of*
the system.

```
incremental_paise = n_treated × (mean per-event recovered value in treated
                                 − mean per-event recovered value in control)
```

Run `npm run validate:incrementality` — it plants a known effect and checks the
system measures it back:

```
planting an effect over 6000 events
  control organic recovery : 10.0%      leakproof arm true lift : +12.0pp

  control    n= 1095  recovered= 105  rate= 9.59%  gross=  ₹10,18,250
  naive      n= 1132  recovered= 162  rate=14.31%  gross=  ₹17,88,550
  leakproof  n= 3773  recovered= 841  rate=22.29%  gross=  ₹80,37,450

  planted truth        ₹47,49,452
  measured incremental ₹45,28,905
  95% interval         [₹28,93,680, ₹59,03,023]     covers truth: YES
  relative error       −4.64%

  gross would have claimed ₹80,37,450 — 1.77× the honest figure

  lift vs control  12.70pp  95% CI [10.41, 14.80]   (planted 12.0pp)
  lift vs naive     7.98pp                          (planted 8.0pp)
```

**1.77×** is the whole argument. A tool reporting gross recovery would claim
nearly twice what this system actually caused.

**The estimators**, all written out rather than pulled from a library, so the
assumptions are visible and testable:

- **Wilson score interval** for each arm's recovery rate. The textbook normal
  interval produces bounds below zero at low rates and degenerates entirely at
  0 or 100% recovery — both of which happen constantly in a two-day corpus.
- **Newcombe's hybrid score interval** for the rate *difference*. Subtracting
  two intervals, or a normal interval on the difference, misbehaves at exactly
  the small rates and unequal arm sizes this experiment runs at.
- **BCa bootstrap** (2,000 iterations, seeded) for the rupee interval,
  resampling per-event recovered *values*. Bootstrapping a rate and multiplying
  by a mean amount would assume a ₹40,000 failure and a ₹200 failure recover at
  the same rate. They do not, and that assumption would understate the
  uncertainty in exactly the direction that flatters the result.
- **Pooled two-proportion z-test** for the p-value, floored at 1e-16 — `p = 0`
  is a claim of impossibility no finite sample can support.

**Everything is reproducible.** The bootstrap RNG is seeded and the seed ships
in the response (`provenance`), so the same corpus gives the same interval on
any machine, forever. `?seed=` lets a sceptical reader re-run it.

**It reports on itself.** Alongside the number: `power_blockers` (why it is not
powered, when it is not), `balance` (a randomisation check on mean ticket size
across arms), `caveats`, and `unpriced_cost_items` — every cost rate still
carrying a placeholder.

**Measured, not assumed.** The 95% interval was checked by simulation, not
trusted: plant an effect, measure it 400 times, count how often the interval
contains the truth. It covers ~93% at demo scale and reaches the full 95% once
the control arm has ~250 recovered events. That gap is reported as a caveat on
the result rather than papered over — and it revealed that the blueprint's
`n_control ≥ 300` power criterion measures the wrong quantity. FAILURES.md #9.

Endpoints: `GET /api/metrics/summary?from=&to=&seed=` and
`GET /api/metrics/timeseries?bucket=5m`.

### The audit ledger

Every decision writes a receipt. `sha256(prev_hash + canonical(record))`, so
any edit to any row invalidates every hash after it.

A complete audit trail for one payment — the "receipt for one rupee":

```
$ curl '/api/ledger?event_id=pay_M3TEST0000'

  seq   3  classified     gate=-
  seq   7  arm_assigned   gate=-
  seq  12  planned        gate=allow:contact_window,under_caps
  seq  15  action_sent    gate=allow:contact_window,under_caps
```

The control arm gets receipts too — `held_out_control` records that we
deliberately did nothing. The experiment's credibility depends on being able to
prove that, not just assert it.

**Three layers of protection, and they catch different things:**

1. **The database refuses to change it.** `UPDATE` and `DELETE` on
   `audit_ledger` raise, enforced by a trigger rather than application code, so
   it holds against a direct `psql` session.
2. **The chain catches content edits.** Every field, at every depth, is hashed.
3. **The chain catches structural edits.** A deleted, inserted or reordered row
   breaks the link.

Verified by attacking it — `npm run ledger:tamper`:

```
attack 1  UPDATE via SQL           → refused by the append-only trigger
attack 2  edit a nested detail     → content_edit detected at seq 3
attack 3  delete a middle row      → broken_link detected at seq 4
```

`verifyChain()` reports *which* row broke and *how*, because "the chain is
broken" is not actionable and "seq 4 does not point at the row before it — a
row was deleted, inserted or reordered" is.

**Canonical serialisation is written out, not a one-liner.** Keys sorted at
every depth, array order preserved, and values JSON cannot round-trip
(`NaN`, `Infinity`, `bigint`) rejected rather than silently coerced to `null`.
The blueprint's suggested one-liner used an array replacer, which is an
allow-list applying at *every* nesting level — it would have left the entire
`detail` payload out of the hash, which is exactly the field worth tampering
with. FAILURES.md #10.

**Appends are serialised by a transaction-scoped advisory lock**, not
`SELECT ... FOR UPDATE` on the head row: `FOR UPDATE` locks rows that exist,
and the first append has no head row to lock, so two concurrent genesis appends
would fork the chain at row one.

Endpoints: `GET /api/ledger` (keyset pagination, filter by arm/action/event/
outcome/date), `GET /api/ledger/verify` (public and unauthenticated — the point
of a hash chain is that anyone can check it; returns **500** on a break so
monitoring cannot ignore it), `GET /api/ledger/export.csv` (streamed, includes
both hashes so the export verifies independently of this app). `ledger.verify`
also runs hourly as a cron.

### The Control Tower

`/tower` — a dense operations console, not a landing page. Dark, tabular,
everything on one screen. It reads from the real pipeline: the queue is
`payment_events` joined to its classification, arm and latest attempt; the KPI
strip is the same `metricsSummary` the judged API returns; the outage banner is
derived from systemic classifications. Nothing is mocked.

```
GET /api/events?filter=&limit=&cursor=   at-risk queue, keyset paginated
GET /api/events/:id/trace                the seven decision-trace cards
GET /api/status                          breaker, live outages, at-risk, mix
GET /api/stream                          SSE — the blueprint's choice over WebSockets
```

Keyset pagination rather than `OFFSET`, because the queue is live-appending and
an offset silently skips or repeats rows as new events land above the cursor —
on this screen that looks like events vanishing.

**Two things the screen refuses to do.**

It will not show an unsupported number confidently. The incremental tile renders
grey and labelled `UNDERPOWERED` when the experiment cannot carry the claim, and
the rail prints the power blockers and caveats *beside* the number rather than
in a methodology note. On a partially-drained batch that currently includes
"mean ticket size differs by 52.2% across arms; the randomisation may not be
clean and the headline number should be treated with suspicion" — the estimator
criticising its own output, on the screen where the output is shown.

It will not conflate *no signal* with *disagreed*. The Payment Downtime API
badge has three states, because a cohort Razorpay has no downtime data for is a
different fact from one Razorpay says is healthy.

**The Decision Trace drawer** (`/tower?event=<id>`) is one click from any row and
is the screen that has to survive scrutiny. Seven cards, each showing the raw
input and the rule output that acted on it: the Razorpay error payload in mono,
the classification with the cohort numbers it was tested against, the arm with
the reproducible hash input, every policy rule with **the values actually
compared** (`contact_window 08:00–19:00 · now 17:05 IST · PASS`), the rail choice
and its alternatives, the message with its prompt hash and token cost, and the
ledger records that receipt the whole thing. `Esc` closes it, the URL is
shareable, and `Copy trace as JSON` hands over everything the drawer rendered.

The banner derives live incidents from classifications rather than reading
`outage_windows`, which is written by an `outage.detect` cron that is not in the
first eight milestones. Same signal, computed instead of cached; when the cron
lands the response shape does not change.

### Replay and what-if

`/replay` — re-runs a historical corpus through the **same pure functions** the
live pipeline uses (`classify`, `evaluatePolicy`, `chooseRail`) under a
different policy, different detector thresholds, or different flags, and reports
what would have changed. Roughly 50,000 events/second; the wait is loading the
corpus, not replaying it.

It calls the production code paths rather than a parallel implementation. That
is the entire reason those functions take every input as an argument and read
neither the clock nor the database — a what-if computed by a second
implementation is a number about the second implementation.

**Replay replays decisions, not outcomes.** If a tighter policy would have
blocked a contact that was in fact sent, replay knows that with certainty: the
gate is deterministic given its inputs. Whether the customer would *still have
paid* is a counterfactual no corpus can answer. So the result keeps two kinds of
number apart, and the screen renders them differently:

| | |
|---|---|
| **Measured** | decision changes, contacts, messages, spend. These follow from the decision alone and are exact. |
| **Modelled** | revenue. Requires an assumption about customer behaviour, which is written into the payload and printed next to the figure. |

A replay screen reporting a confident rupee delta without saying which of the
two it is doing is the most persuasive way to be wrong in this whole project.

Running it also exposed two bugs worth reading about, both in
[FAILURES.md](FAILURES.md):

- **#20 — the 15-minute cohort window had no upper bound.** It summed every
  counter bucket from the window start *forward*, for ever. Invisible on live
  traffic, because the future has not happened yet; severe on anything
  backfilled. A generated batch pushes a day of events through in eight minutes,
  so a "15-minute window" was returning `n=3,387` at the whole day's average
  decline rate — the `n ≥ 8` guard stopped meaning anything, and a real spike was
  diluted into the daily mean. The replay engine found it by disagreeing with
  history about a number neither should have been able to move.
- **#21 — replay compared authorised contacts against sent ones.** On a day when
  the gate had correctly deferred everything to the next working day, that read
  as a +1,624-contact policy effect. Both sides now derive from the decision, and
  events with no recorded verdict are excluded and counted.

### The synthetic data generator

Every number LEAKPROOF reports about itself was computed over a corpus this
generator made, so it is a first-class part of the repo rather than a script
somebody ran once. **How it was built is published**, in
[docs/data-generation.md](docs/data-generation.md), because that is the
difference between a lift you can audit and a lift you have to take on trust.

All customer data in this system is synthetic. Every screen says so.

```bash
npm run simulate                        # 3,000 at-risk events + a 45-min HDFC card outage
npm run simulate -- --preset panel      # small and fast, for a live demo
npm run simulate -- --preset null_test  # the A/A test: no effect planted at all
npm run simulate -- --dry-run           # describe the batch, write nothing
```

or `POST /api/simulator/generate` → `202 { batch_id }`, operator-guarded, with
the work running in Inngest.

**A batch is a pure function of its seed.** Same spec in, byte-identical events
out, on any machine, forever — asserted in the tests, not hoped for. The seed is
stored on the batch row, so the corpus behind any reported number can be
regenerated and checked.

`count` is the number of **failed** events. Successes are generated on top —
roughly ten per failure — because the cohort decline rate is a ratio and a
corpus of nothing but failures makes every cohort read 100% declined, which
makes the systemic detector meaningless.

What is modelled, and why each one earns its place:

| | |
|---|---|
| Log-normal tickets per method | The tail is the hard part. Uniform amounts would engineer away the variance that dominates the rupee interval. |
| Diurnal curve + payday cycle | The overnight trough is what produces cohorts below `n ≥ 8`. A detector never shown a quiet hour will call an outage off three transactions. |
| A realistic outage payload mix | 30% unhelpful `gateway_technical_error`, 22% Razorpay's `payment_failed` shrug, and 8% ordinary customer failures that happen to land in the window. Uniformly labelling them `issuer_down` would make detection trivial and the test worthless. |
| Organic recovery threaded by `order_id` | A new payment id against the same order, exactly as Razorpay does on a retry. The control arm recovers by no other route. |
| Right-censoring | A recovery that would land after the window closes is not emitted — it has not happened yet. On a 4-hour window that is over a third of them. |
| Adversarial cases | Unlabelled errors, byte-identical redeliveries, recoveries that arrive *before* their failure, opted-out customers, webhooks hours late. |

**Ground truth is per event and counterfactual.** Systemic-or-not comes from the
payload the generator planted, not from membership of the outage window — an
insufficient-funds decline inside the outage is still idiosyncratic, and
counting it as systemic would hand the detector precision it did not earn. And
recovery is decided by a *single* uniform draw, so the generator knows which
recoveries the treatment actually **caused**:

```
recovers              when  u < organic + uplift
would have anyway     when  u < organic
caused by treatment   when  organic ≤ u < organic + uplift
```

That distinction is not pedantry. The first version reported ground truth as
`n × (mean_treated − mean_control)`, which is *the estimator's own formula* —
comparing the two would have proved the arithmetic ran twice. Against the real
counterfactual, one 24-hour seed gave ₹8,97,066 planted against ₹2,37,201
measured: a 3.8× gap, entirely from which arm caught the largest tickets, while
the *rate* lift over the same corpus was accurate to within a percentage point.
Read the interval, not the point, and prefer the rate.
[FAILURES.md](FAILURES.md) #14.

`GET /api/simulator/batches/:id` puts planted next to measured — detection
precision/recall against per-event truth, and whether the incrementality
interval covered the counterfactual.

⚠️ **Read this before believing any lift measured on synthetic data.** A
synthetic customer cannot pay a real Razorpay payment link, so on synthetic data
the treated arms have no mechanism to actually recover more money. The uplift is
**planted by construction**. It validates that the estimator recovers an effect
known to be present; it is **not** evidence that LEAKPROOF recovers revenue on
real traffic. The A/A preset plants nothing at all, and that is the more
valuable of the two: an estimator that reports a lift on data containing none is
broken, and no A/B result from it can be trusted afterwards.

An injected outage is also, by construction, detectable. Real degradation is
messier — partial, drifting, overlapping. The precision and recall above are an
upper bound, and real-traffic validation is untested.

`POST /api/simulator/push-to-razorpay` creates genuine test-mode **orders** for a
subset, so ids resolve in the Razorpay dashboard. It does not manufacture a real
decline: payments are created through checkout, not the API. The part that is
real end to end is the recovery rail.

### Recovery detection

Three paths, deliberately distinct:

- **attributed** — a recovery link was paid. `payment_link.paid` carries our
  attempt UUID as `reference_id`, so attribution is exact.
- **organic, payments** — the payment simply succeeded. Razorpay issues a *new*
  payment id for a retry, so the **order id** is the only thread tying it back
  to the failure it resolves.
- **organic, subscriptions** — `subscription.charged`. The at-risk row's id
  *is* the subscription id, so it matches directly.

The organic paths are not a nicety: they are the only way the control arm ever
records a recovery. Without them the control rate reads zero and every
incrementality figure is inflated to the point of fraud.

### The subscription surface

A halted subscription is an at-risk unit exactly like a failed payment, and it
joins the **same** pipeline — same table, same classifier, same policy gate,
same experiment arms. Only `surface` differs.

```
sub_EMBEDDED0001    upi   ₹998.00  mandate_invalid  leakproof  mandate_repair  sent
sub_TXsbmklSi9BjcX  card  ₹499.00  mandate_invalid  control    —               held out
```

Two details that needed checking against the live API rather than assuming:

- **The amount is not on the subscription.** It lives on the plan, and the
  subscription entity embeds `plan` on the *create* response but **not** on the
  list endpoint — so neither can be assumed. The embedded plan is used when
  present and a plan lookup fills in when it is not. Amount is
  `plan.item.amount × quantity`; ignoring quantity would understate a
  multi-seat subscription.
- **`subscription.halted` classifies as `mandate_invalid`, and customer-side.**
  Razorpay halts only after retries are exhausted, so the mandate genuinely can
  no longer be charged and `mandate_repair` is the one rail that can fix it.
  Customer-flavoured matters: a wave of halted subscriptions is a wave of
  individually broken mandates, not an outage, and must never trip the circuit
  breaker.

### Data model

18 tables, `drizzle/0000_init.sql`. The blueprint's 15, plus:

- `failed_jobs` — Inngest dead-letter, surfaced in `/settings`
- `cohort_counters`, `cohort_baselines` — the rolling-window counters the
  blueprint puts in Redis. Upstash is not provisioned, so they are Postgres
  tables behind a `CohortStore` interface; the swap back is one file.

`audit_ledger` is append-only, **enforced by a database trigger** rather than by
application code, so the hash chain holds even against a direct `psql` session.
Verified: `UPDATE` and `DELETE` both raise.

---

## Architecture

```
Razorpay TEST MODE ──webhooks──▶ /api/webhooks/razorpay
                                        │ verify sig + replay guard
                                        ▼
                                 webhook_receipts (idempotent)
                                        │  emit
                              ┌── INNGEST DURABLE BUS ──┐
                              ▼                          ▼
                       ingest.webhook  ────────▶  triage.classify
                              │                          │
                     cohort counters              pure classifier
                              │                          │
                              ▼                          ▼
                          Postgres (Neon) ◀── audit_ledger (hash chain)
```

Route handlers are thin: validate → call a service → serialize. Logic lives in
`src/core/*` as pure functions wherever it can.

```
src/core/
  ingest/     normalize.ts, persist.ts
  triage/     taxonomy.ts, classifier.ts, cohort-store.ts, config.ts
  policy/     schema.ts, evaluate.ts, tz.ts, breaker.ts, breaker-store.ts,
              holidays.ts, store.ts, context.ts
  routing/    static-table.ts
  rails/      razorpay.ts
  messaging/  templates.ts
  cost/       meter.ts
  experiment/ assign.ts, stats.ts, metrics.ts, metrics-store.ts, recovery.ts
  ledger/     canonical.ts, append.ts, verify.ts
  replay/                                                        ← milestone 8
src/jobs/     Inngest function definitions
src/app/api/  route handlers
scripts/      migrate, reset, dns-fallback
```

Durable scheduling is load-bearing, not decoration: recovery is inherently
time-shifted — retry near payday, wait out an outage window, escalate after 72
hours. A real queue rather than `setTimeout` is one of the clearest signals
separating a working system from a demo.

---

## Conventions

- Money is **always paise, always an integer**. Never a float, never rupees.
- Timestamps are ISO-8601 with offset; `timestamptz` in the database.
- PII is hashed and masked at ingestion. No raw phone number or email is ever
  stored — `phone_hash` + `phone_masked` (`+91••4821`), and nothing else.
- Every error is the same envelope: `{error:{code, message, detail?, request_id}}`.

---

## Deliberate cuts and known limitations

Stated up front rather than discovered by a judge. Full detail in
[FAILURES.md](FAILURES.md).

- **No Thompson-sampling bandit for rail routing.** A bandit needs volume to
  beat a good static table, and a two-day synthetic corpus does not have it; an
  unconverged bandit is a random number generator with a nice name. Rail routing
  is a static `failure_class → ordered rail list` table. The `bandit_arms` table
  and the α/β update path ship anyway behind `FEATURE_BANDIT=false`, so the
  design is reviewable.
- **The Payment Downtime API's test-mode data looks like fixtures.**
  `GET /v1/payments/downtimes` returns 200 on test-mode keys and covers
  `netbanking`, `card`, `upi` and `fpx` — but all 16 rows are simultaneous,
  unresolved, high-severity, which is not a plausible production state. The
  agreement scorecard is therefore fed by the simulator's injected windows and
  says so on screen. Agreement is recorded as `NULL`, not `false`, when there is
  no signal for a cohort: "no signal" and "disagreed" are different facts.
  FAILURES.md #6.
- **Bank holidays come from a national calendar, not RBI's state-wise list.**
  Gazetted holidays only — observances are filtered out, because caching them
  would have deferred recovery on 54 days a year. A state-only holiday is
  currently treated as a working day. FAILURES.md #5.
- **Triage thresholds are now tuned, and the tuning moved one of them.**
  `npm run tune:triage` scores the detector against 1,165 ground-truth systemic
  events: 94.6% precision, 93.6% recall. The blueprint's 0.25 absolute floor
  scored 77.4% precision and missed the bar, so it ships at 0.35. Two caveats
  stay: the σ guard is inert at these settings (the floor always binds first, so
  it is two guards not three), and an injected outage is by construction
  detectable — these numbers are an upper bound and real-traffic validation is
  untested. FAILURES.md #11–13.
- **The EWMA baseline never advances, deliberately.** `updateBaseline` is
  implemented and uncalled. Advancing it from closed 5-minute buckets, as the
  blueprint's `outage.detect` would, drops recall from 97% to 0.8%: a 5-minute
  bucket holds ~6 attempts and an EWMA cannot tell that sampling noise from real
  volatility, so σ inflates past the outage it is meant to catch. Every cohort is
  judged against a seeded prior. The principled fix is a binomial test that knows
  `n`, and it is not built. FAILURES.md #11.
- **A synthetic batch's lift is planted, and its attribution is meaningless.**
  A synthetic customer cannot pay a real payment link, so treated arms have no
  mechanism to recover more money and any uplift is put there by the generator.
  It validates the estimator; it does not evidence the product. Every recovery
  on a synthetic batch also arrives as *organic*, so the attributed/organic
  split reads 0% — the incrementality maths is unaffected, since it measures
  rupees rather than attribution.
- **The downtime agreement rate is 0 on synthetic data, by construction.** The
  cross-check is wired and runs, but Razorpay's feed cannot corroborate an
  outage the generator invented. The number only becomes meaningful against real
  traffic, and the scorecard reports how many windows the feed had an opinion on
  so it cannot be quoted without that context.
- **Detection numbers recorded before the cohort-window fix are understated.**
  Classifications already in the database were produced by the unbounded-window
  code (FAILURES.md #20) and are not re-run automatically. The replay engine
  detects a large classification swing and says explicitly that it may be
  measuring a code change rather than the policy under test.
- **A recovery is recorded by timestamp, not by label.** Every metric keys off
  `recovered_at`, never `state = 'recovered'`. `state` is written by four
  different jobs and a recovery landing mid-pipeline used to have its label
  overwritten by a stage that started earlier and finished later — which zeroed
  the headline number *and* disarmed the `stop_on: payment_success` rule that
  stops us chasing someone who has already paid. Terminal states are now
  terminal (`setEventState`), and the metrics read the fact regardless.
  FAILURES.md #19.
- **The rupee point estimate is high-variance and the interval is not
  decoration.** Measured against a counterfactual ground truth on a heavy-tailed
  corpus, one seed's planted ₹8,97,066 came back as a ₹2,37,201 point estimate,
  while the *rate* lift was accurate to within a percentage point. Lead with the
  rate; read the interval, not the point. FAILURES.md #14.
- **WhatsApp is written but cannot send, for two separate reasons.** The Meta
  Cloud API client exists and is tested; credentials are unset (Business
  account, verified sender, approved template). The second blocker is
  architectural: every other rail is delivered by Razorpay's own `notify` flag,
  so **Razorpay** holds the customer's contact and this system stores only a
  sha256 and a display mask. Sending via Meta would require storing raw phone
  numbers for every at-risk customer — a privacy decision, not a configuration
  one. The rail degrades to SMS and records why, with both blockers named
  separately. FAILURES.md #25.
- **No Hinglish voice rail** (`FEATURE_VOICE=false`); **subscriptions, not
  invoices**, as the second surface.
- **`subscription.charged` is handled in code but must be registered on the
  webhook.** It is the only signal for a halted subscription recovering
  *organically*, and without it the subscription surface's control arm reads
  zero and its incrementality is inflated — the same trap the `order_id` path
  avoids for payments.
