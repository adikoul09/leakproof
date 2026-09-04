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
| 6 | Synthetic data generator | 🟡 ingest endpoint live, generator pending |
| 7 | Control Tower dashboard | ⬜ |
| 8 | Replay / what-if engine | ⬜ |

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

Other scripts: `npm test`, `npm run typecheck`, `npm run db:generate`,
`npm run db:studio`, `npm run db:reset -- --yes` (development only), and
`npm run gate -- <event_id>` to print the policy trace for a real event, and
`npm run validate:incrementality` to plant a known effect and check the maths
recovers it, and `npm run ledger:tamper` to attack the hash chain and watch it
detect the tampering.

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

- `cohort_n ≥ 8` — small-sample guard
- `decline_rate > baseline + 3σ` (EWMA baseline, α = 0.3)
- `decline_rate > 0.25` absolute floor

Confidence is `logistic(z)` clipped to [0.5, 0.99].

A `customer`-flavoured failure **never** becomes systemic no matter how many
arrive together. Ten people short of funds is not an outage, and treating it as
one parks recoverable revenue behind a circuit breaker. Demonstrated: an
`insufficient_funds` payment sitting inside a cohort running at a 60% decline
rate still classifies `idiosyncratic`, while the `issuer_down` payments beside
it classify `systemic / issuer_degraded` at 0.99.

Both stages are pure functions taking every input as an argument — no database,
no clock. That is what lets the replay engine drive the *same* code over a
historical corpus instead of a second implementation that drifts.

**The Payment Downtime API is recorded, never consulted.**
`classifications.downtime_api_agrees` is written by the outage detector as
agreement evidence. Feeding it into the classifier would make validating the
classifier against it circular, and the resulting precision/recall number would
mean nothing.

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

### Recovery detection

Two paths, deliberately distinct:

- **attributed** — a recovery link was paid. `payment_link.paid` carries our
  attempt UUID as `reference_id`, so attribution is exact.
- **organic** — the payment simply succeeded. Razorpay issues a *new* payment
  id for a retry, so the **order id** is the only thread tying it back to the
  failure it resolves.

The organic path is not a nicety: it is the only way the control arm ever
records a recovery. Without it the control rate reads zero and every
incrementality figure is inflated to the point of fraud.

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
- **Triage thresholds are untuned.** `n ≥ 8`, `3σ`, `0.25`, `α = 0.3` are the
  blueprint's starting guesses. They have to clear precision *and* recall above
  0.8 against the generator's injected outage, and that has not been measured.
- **No Hinglish voice rail** (`FEATURE_VOICE=false`); **subscriptions, not
  invoices**, as the second surface.
