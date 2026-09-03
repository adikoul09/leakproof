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
| 2 | Policy engine (caps, contact window, stop_on, breaker) | ⬜ |
| 3 | One recovery rail end to end (Razorpay Payment Link) | ⬜ |
| 4 | Control group + incrementality maths | ⬜ |
| 5 | Hash-chained audit ledger | 🟡 table + append-only trigger live |
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

Other scripts: `npm run typecheck`, `npm run db:generate`, `npm run db:studio`,
`npm run db:reset -- --yes` (development only).

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
  policy/ routing/ messaging/ experiment/ ledger/ replay/ cost/   ← milestones 2–8
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
- **The Payment Downtime API only covers `card` and `ach`** — not `netbanking`,
  not `upi`. So the flagship outage scenario is a **card issuer outage**. For
  netbanking and UPI cohorts the detector runs on internal signal alone and
  agreement is recorded as `NULL`, not `false`: "no signal" and "disagreed" are
  different facts and the scorecard must not conflate them.
- **Triage thresholds are untuned.** `n ≥ 8`, `3σ`, `0.25`, `α = 0.3` are the
  blueprint's starting guesses. They have to clear precision *and* recall above
  0.8 against the generator's injected outage, and that has not been measured.
- **No Hinglish voice rail** (`FEATURE_VOICE=false`); **subscriptions, not
  invoices**, as the second surface.
