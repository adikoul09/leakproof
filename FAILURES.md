# FAILURES.md

A live log of everything that broke, every assumption that turned out wrong, and
every thing we decided not to build. Kept honest — entries are added when they
happen, not reconstructed afterwards.

Format: what broke → what it cost → what we did → what it means for the system.

---

## 1. Neon's hostname does not resolve on this network

**When:** Milestone 1, first `db:migrate`.
**Symptom:** `getaddrinfo ENOTFOUND ep-floral-wave-b3gr9a5a.c-4.ap-southeast-1.aws.neon.tech`
while `curl https://neon.tech` returned 200 fine.

**Diagnosis:** the local router's DNS (`192.168.29.1`) returns `REFUSED` for Neon's
per-endpoint subdomains. Resolving the same name against `1.1.1.1` works and gives
`52.76.246.190`. So: not a credentials problem, not a Neon outage, a local resolver
refusing a wildcard subdomain.

**First fix attempted and rejected:** `dns.setServers(['1.1.1.1'])`. Does nothing —
Node's `dns.lookup`, which every socket library actually calls, goes through the
system resolver (`getaddrinfo`), not through Node's own DNS client. `setServers`
only affects `dns.resolve*`.

**Fix:** [`scripts/dns-fallback.cjs`](scripts/dns-fallback.cjs) patches `dns.lookup`
to resolve through an explicit public resolver and fall back to the system one.
Opt-in via `npm run dev:dnsfix` / `npm run db:migrate:dnsfix`; the normal scripts
are untouched. The real fix is setting the machine's DNS to `1.1.1.1`.

**Cost:** ~15 minutes.
**What it means:** nothing about the system's design — but it is a good argument
for the "database down → webhook returns 503 so Razorpay retries" rung of the
degradation ladder. A DNS failure looks exactly like a database outage from
inside the process, and the handler already treats it as one.

---

## 2. Inngest v4 has no `EventSchemas`

**When:** Milestone 1, wiring the durable bus.
**Symptom:** `Module '"inngest"' has no exported member 'EventSchemas'` on
`inngest@4.19.0`.

**Diagnosis:** v4 replaced the `EventSchemas().fromRecord<T>()` typing pattern with
a new `eventType` / `staticSchema` trigger API. Every piece of documentation,
example and blog post reachable in the time available is written for v3.

**Fix:** pinned `inngest@^3` (3.54.2). Deliberate: on a 28-hour build, the cost of
being the first person to write something against a freshly-redesigned API is not
worth whatever v4 improves.

**Cost:** ~5 minutes.
**What it means:** documented as a version pin, not a silent constraint. Worth
revisiting after the deadline, not during it.

---

## 3. The EWMA baseline poisoned itself and silently killed outage detection

**When:** Milestone 1, first end-to-end run through the classifier.
**Symptom:** five HDFC card failures in a cohort running at a **60% decline rate**
were all classified `unknown / gateway_error` instead of `systemic / issuer_degraded`.
No error, no warning — the detector just quietly stopped detecting.

**Diagnosis:** `triage.classify` was advancing the cohort's EWMA baseline once per
classified event, using the live rolling window. The very first failure in a fresh
cohort has a window of n=1, decline rate **1.0**. One update with α=0.3:

```
mean = 0.3 × 1.0  + 0.7 × 0.08   = 0.356
var  = 0.3 × 0.92² + 0.7 × 0.0025 = 0.2557   → σ = 0.506
threshold = mean + 3σ = 1.873
```

A decline rate above 1.873 is not reachable — the rate is a proportion. **One
event permanently disabled systemic detection for that cohort**, and because
"not systemic" is a legitimate answer, nothing anywhere looked broken. Confirmed
by reading `cohort_baselines` directly: `ewma_rate 0.356, ewma_var 0.2557`.

**Fix:** `triage.classify` no longer touches the baseline at all. Baseline
maintenance belongs to the `outage.detect` cron, which can see whether a window
is currently flagged as an outage and skip it. `updateBaseline` stays in
`CohortStore` with a comment naming its one legitimate caller.

**Cost:** ~20 minutes, most of it working out that a *silent* wrong answer was
being produced rather than an error.

**What it means — the real lesson:** a live signal must never be fed back into
the baseline it is measured against. This is the same failure mode as letting the
Payment Downtime API be an input to the classifier it is supposed to validate,
which the blueprint already forbids (6.5, step 5). Both are circularity; only one
of them was written down in advance. Two guards now exist against the general
shape of this mistake:

1. Baselines are advanced only from windows a detector has already judged quiet.
2. The Downtime API is *recorded* (`downtime_api_agrees`), never consulted.

Also worth stating plainly: the untuned constants in `src/core/triage/config.ts`
are not the risky part. **The feedback topology is.** Bad thresholds produce
visibly bad numbers; a bad feedback loop produces plausible ones.

---

## 4. gitleaks did not flag live credentials sitting in a markdown table

**When:** Milestone 1, pre-push secret scan.
**Symptom:** `gitleaks git --staged` and a full-history scan both reported **no
leaks**. Good news — but worth checking *why* before trusting it.

**Diagnosis:** scanning the whole directory including ignored files found 6
secrets in `.env.local`, so the scanner works. But `Requirements.md` — which
holds the same live Razorpay key, Neon password, Gemini key and Inngest signing
key, in a markdown table — produced **zero findings**. Verified by copying it to
a scratch directory and scanning that alone: 0 hits.

`gitleaks`' `generic-api-key` rule keys off `KEY=value` / `"key": "value"`
shapes. A pipe-delimited markdown table does not look like that, so a
`| rzp_test_… | V5BNEk4… |` row sails straight through.

**Fix:** none needed for this repo — `Requirements.md` is in `.gitignore` and
was never staged. The point is the reasoning: **`.gitignore` is what is
protecting that file, not the scanner.** A clean gitleaks report is a second
line of defence, not the first, and treating it as the first is how credentials
get published.

**Cost:** ~5 minutes, entirely voluntary. Nothing was broken.

**What it means:** the pre-push ritual is now "confirm the ignore rules cover
the secret-bearing files, *then* scan", in that order. Reversed, it gives false
confidence. Also relevant to `.next/` — the production build inlines env values
into `.next/cache` and `.next/prerender-manifest.json`, which the same scan
caught. Already ignored, but it is a reminder that build output carries secrets.

---

## 5. The blueprint's holiday API has no Indian data — and its replacement nearly blocked 54 days a year

**When:** Milestone 2, seeding the bank-holiday cache.
**Symptom:** `npm run db:seed` reported `holiday source unreachable`. The gate
worked, but with an empty holiday set — so bank-holiday awareness, which is a
stated pitch talking point, was silently doing nothing.

**Diagnosis, part one:** Nager.Date returns **HTTP 204 No Content** for `IN`.
Not an error, not a timeout — it simply has no Indian holiday data. My fetch
treated any non-`res.ok` as a skip, and 204 *is* ok, so `res.json()` threw on an
empty body and got swallowed by the catch that exists to tolerate outages. The
blueprint chose a holiday source that does not cover the one country this
product is for, and the failure presented as a network problem.

**Diagnosis, part two — the more interesting one.** Replacement source: Google's
public "Indian Holidays" ICS calendar. It returns 200 with real data, needs no
API key. Seeding it cached **78 holidays across two years**. That number is
absurd on its face, and chasing it down is what mattered: each VEVENT carries a
DESCRIPTION of either `Public holiday` (gazetted — banks shut) or `Observance`
(cultural — banks open, settlement runs perfectly well). For 2026 that split is
**18 public holidays against 36 observances**.

Caching all of them would have deferred every recovery attempt on 54 days a
year, most of them ordinary working days. That is not caution. It is roughly
15% of the calendar of lost recovery, arriving as a defer that looks correct in
every trace.

It also would have broken the demo: **2026-09-04, the build date, is
Janmashtami** — the gate deferred every single event, and the first `gate-probe`
run showed exactly that.

**Fix:** cache only entries whose DESCRIPTION starts with `Public holiday`. Two
years dropped from 78 to 32. Spot-checked the result — Gandhi Jayanti, Dussehra,
Diwali, Guru Nanak Jayanti, Christmas, Janmashtami — which is what a gazetted
list should look like.

**Cost:** ~25 minutes.

**What remains wrong, stated rather than hidden:** RBI's real holiday list is
**state-wise**, and a single national calendar cannot express that. A Kerala
customer on a Kerala-only bank holiday is treated as a working day here. The
error now runs in the under-blocking direction — a wasted contact rather than a
wasted day — which is the cheaper mistake, but it is still a mistake. The
production fix is RBI's published state-wise list keyed by customer state;
nothing else changes, because the gate only ever reads `holidays_cache`.

**What it means:** an integration returning 200 with *plausible* data is more
dangerous than one returning 500. The 204 announced itself. The 78 holidays did
not — they would have quietly degraded recovery, in a direction that looks
conservative and responsible in every individual decision trace.

---

## Deliberate cuts (not failures — decisions, stated up front)

These are in the pitch, not hidden in a footnote.

| Cut | Why | What was built instead |
|---|---|---|
| **Thompson-sampling bandit** for rail routing | The bandit needs volume to beat a good static table, and volume is exactly what a two-day synthetic corpus does not have. A bandit that has not converged is a random-number generator with a nice name. | Static `failure_class → ordered rail list` table. The `bandit_arms` table and the α/β update path ship anyway, behind `FEATURE_BANDIT=false`, so the design is legible and reviewable. |
| **Hinglish voice rail** | Highest effort-to-credibility ratio on the board. | `FEATURE_VOICE=false`. |
| **Invoices as a second surface** | Subscriptions/dunning is where the recovery story is stronger. | `FEATURE_SUBSCRIPTIONS=true`, `FEATURE_INVOICES=false`. |

---

## Known limitations (design-level, stated in the README too)

**Payment Downtime API only covers `card` and `ach`.** The blueprint originally
built the flagship outage demo on a *netbanking* outage cross-checked against
Razorpay's Payment Downtime API. Checking the current API reference: the
`method` field on `payment.downtime` supports `card` and `ach` only — not
`netbanking`, not `upi`. So the flagship scenario is a **card issuer outage**.
For netbanking and UPI cohorts the detector runs on internal signal alone and
`classifications.downtime_api_agrees` is recorded as `NULL`, not `false` — "no
signal" and "disagreed" are different facts and the agreement scorecard must not
conflate them.

**Downtime API in test mode is unconfirmed.** Whether `GET /v1/payments/downtime`
returns 200 or 403 on test-mode keys is not stated in the docs. To be verified
with a real call before the Outage Radar's agreement scorecard is built; if it
403s, the scorecard is fed from the simulator's injected windows and that is
labelled as such on screen.

**Cohort counters live in Postgres, not Redis.** The blueprint specifies a Redis
sorted set for the 15-minute rolling decline rate. Upstash is not provisioned, so
`cohort_counters` / `cohort_baselines` are Postgres tables behind a `CohortStore`
interface. Correctness is identical; latency is worse; the swap is one file.

**Triage thresholds are untuned.** `n ≥ 8`, `3σ`, `0.25` absolute floor, EWMA
`α = 0.3` are the blueprint's starting guesses, sitting in
`src/core/triage/config.ts`. They are not yet tuned against the generator's
injected outage, and the bar they have to clear — precision *and* recall above
0.8 — has not been measured yet.

**Bank holidays are a national list, not RBI's state-wise one.** See #5 above.

**Policy write endpoints use a shared operator key, not the JWT session.** The
blueprint's `/api/auth/login` is not built yet and the demo URL is public, so
`POST /api/policies`, `/publish` and `/breaker/override` sit behind a bearer
`OPERATOR_ACCESS_KEY`, constant-time compared. An unauthenticated write is
refused rather than quietly allowed. Replaced by the JWT session when auth lands.

**The webhook runs unverified in local development.** `RAZORPAY_WEBHOOK_SECRET`
cannot exist until there is a public URL to register the webhook against. Until
then the route accepts unsigned requests **in development only**, logging a loud
warning per request. In production a missing secret is a 401, not a bypass.
