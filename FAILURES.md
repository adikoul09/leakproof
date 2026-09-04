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

## 6. The Downtime API assumption was wrong in three ways at once

**When:** Milestone 3, closing the one open question from the kickoff brief.

The brief carried an "important correction" to the blueprint, which locked a
decision: the Payment Downtime API's `method` field supports only `card` and
`ach`, therefore the flagship outage demo had to be a **card issuer outage**
rather than the netbanking outage originally designed, and netbanking/UPI
cohorts would have to run on internal signal alone.

I checked it against the live API with the test-mode keys instead of taking it
on trust. Three things were wrong:

**1. The endpoint in the brief does not exist.** `GET /v1/payments/downtime`
(singular) returns `400 BAD_REQUEST_ERROR — "The id provided does not exist"`.
It is being routed to `GET /v1/payments/:id` with `"downtime"` read as a payment
id. The real endpoint is **`/v1/payments/downtimes`**, plural. A wrong-endpoint
404 would have been obvious; a 400 complaining about an id looks like an auth or
data problem and would have cost real time on deadline day.

**2. It works on test mode.** 200, with 16 items. The brief flagged 403 as a
live risk, and the Outage Radar's agreement scorecard had a documented fallback
ready for it. Not needed.

**3. It covers far more than card/ach:**

```
methods:     netbanking 5 · card 4 · upi 4 · fpx 3
instruments: netbanking {bank}  card {issuer}  upi {vpa_handle}  fpx {bank}
```

So the constraint that forced the demo scenario away from netbanking is not
real. **The card issuer outage remains a perfectly good scenario and nothing is
blocked** — but it is now a choice rather than a workaround, and netbanking and
UPI cohorts can be cross-checked after all.

**🔸 One caveat I cannot resolve from here:** all 16 rows have
`status: "started"` and `severity: "high"`, with `begin` timestamps spread from
April to August 2026 and `end: null` throughout. Sixteen simultaneous unresolved
high-severity outages is not a plausible production state, so this is very
likely **test-mode fixture data rather than a live feed**. That does not change
the schema, the endpoint or the supported methods — all of which are what the
integration needs — but it does mean the agreement scorecard cannot be validated
against real production downtimes from a test account. The scorecard will be fed
by the simulator's injected windows, and labelled as such on screen.

**Cost:** ~10 minutes. It closed an open question, un-blocked a scenario, and
found an endpoint typo that would have been expensive to debug later.

**What it means:** the brief's correction was itself carefully reasoned and
still wrong, because it was reasoned from documentation rather than from a
request. One `curl` settled it. Every remaining 🔸 ASSUMPTION in this repo that
can be resolved by a single API call should be, before it is designed around.

---

## 7. The policy gate ran three times and blocked an attempt it had already sent

**When:** Milestone 3, first end-to-end run of the recovery rail.
**Symptom:** two attempts had a real Razorpay link, a real short URL, a sent
message and a recorded cost — and were marked `outcome: 'stopped'`, with the
event in `blocked_by_policy`. Every individual row looked plausible. Only the
timestamps gave it away: `executed_at` came *before* `outcome_at`. Something
sent the message and then decided it should not have.

**Diagnosis:** not a retry — every HTTP response was 200 or 206. That is the
clue. Inngest executes a durable function by **replaying the whole function body
from the top at every step boundary**, serving memoised results for steps that
already ran. Code outside `step.run` is therefore not "run once" — it runs once
per step boundary, with fresh inputs each time.

I had left the policy gate outside a step:

```ts
const now = new Date();                                   // ← fresh every pass
const { context } = await buildPolicyContext(eventId, policy, now);  // ← re-queries
const decision = evaluatePolicy(policy, context);         // ← re-decides
```

`buildPolicyContext` counts `max_contacts_per_customer_per_week`. All four test
events shared one customer. So: pass 1 evaluated `allow` and sent. Pass 2 sent
the second. By pass 3 the context counted the two messages the job had *itself
just sent*, hit the cap of 2, returned `block` — and the `abandon` branch marked
an already-delivered attempt as stopped.

**The gate was reading counters that the gate's own decision had moved.**

**Fix:** the whole gate — context build, evaluation, and the
`policy_evaluations` insert — moved inside one `step.run('evaluate-gate')`, in
both `recovery.plan` and `recovery.execute`. The decision is memoised, so every
replay sees the answer the gate actually gave. Belt and braces: the abandon
branch now re-reads `executed_at` and refuses to mark a sent attempt as stopped,
because an attempt that has gone out cannot be un-sent and saying otherwise
would be a lie in the ledger.

Confirmed by the evaluation count: three events previously produced five
`policy_evaluations` rows in an unpredictable pattern. They now produce exactly
two each — one at plan, one at the execution-time re-check, which is precisely
what the design says should happen.

**Cost:** ~35 minutes, most of it not believing "no errors" and looking for a
retry that did not exist.

**What it means, and it generalises past Inngest:** this is the same class of
bug as #3. In #3 a live signal fed the baseline it was measured against. Here a
gate read counters its own decision incremented. Both produce *plausible* wrong
answers rather than errors, which is what makes them expensive. The rule now
applied everywhere: **anything that reads mutable state must be inside a step,
and a decision must be recorded at the moment it is made, not recomputed later.**
`evaluatePolicy` being pure is what made the fix a three-line move rather than a
redesign — the impurity was all in the caller, where it was visible.

---

## 8. `reference_id` collisions would have broken every demo re-run

**When:** Milestone 3, second end-to-end run.
**Symptom:** `BAD_REQUEST_ERROR — payment link with given reference_id:
pay_M3TEST0000:1 already exists`. One event's link was created; two failed.

**Diagnosis:** I set `reference_id` to `${eventId}:${attemptNo}`. Razorpay
enforces uniqueness on `reference_id` **per account, permanently** — it does not
know or care that I truncated my database between runs. So the second run tried
to reuse a reference the first run had already consumed.

The one event that succeeded was the tell: its rail was
`card_retry_delayed_payday`, which sleeps 48 hours, so its earlier run never
reached link creation and never consumed the reference.

**Why it mattered more than a test annoyance:** the demo re-runs the simulator.
Every re-run after the first would have failed to create links, on stage,
with an error that reads like a Razorpay problem rather than an id problem.

**Fix:** `reference_id` is now the attempt's own UUID — fresh on every run,
because the row is new. And rather than treating a duplicate as fatal,
`createPaymentLink` now catches it, looks the existing link up by reference, and
returns that. Razorpay's uniqueness constraint becomes a free idempotency key:
a customer can never receive two links for one attempt, and an attempt can never
be marked failed because it already succeeded.

**Cost:** ~15 minutes.

**What it means:** an idempotency key has to be unique over the lifetime of the
*external* system, not the local database. Anything derived from data I can
truncate is not an idempotency key, it is a collision waiting for the worst
possible moment.

---

## 9. The blueprint's power criterion is the wrong criterion, and I only found out by measuring coverage

**When:** Milestone 4, validating the incrementality maths.

The blueprint defines the experiment as adequately powered when the confidence
interval excludes zero **and `n_control ≥ 300`**. I implemented that, and it
passed every unit test — because unit tests check that arithmetic matches a
formula, and the formula was implemented correctly.

So I asked the question the unit tests could not: **does the 95% interval
actually cover?** Plant a known effect, measure it a few hundred times over
noisy samples, and count how often the interval contains the truth.

**First result: 91.7% against a nominal 95%.** An interval that covers 92% of
the time while claiming 95% is not a rounding error — it is a systematically
overconfident claim, and overconfidence is the specific failure this whole
project exists to avoid.

**First fix, and a false start.** The percentile bootstrap is known to
under-cover on skewed data, and recovered revenue is very skewed — a handful of
large tickets dominate. So I implemented **BCa** (bias-corrected and
accelerated), which is the standard remedy. Result: 91.0%. No better.

**The actual bug was in my test.** I was comparing the interval against a
"truth" computed from the *observed* pooled mean ticket — a quantity that is
itself random and moves with the sample. Against the true population mean,
coverage was **93.3%** (percentile) and **92.8%** (BCa). The estimator was
always closer to correct than my measurement of it.

**Then the real finding.** Coverage still was not 95%, so I varied the control
arm and measured again:

| events in control | recovered in control | measured coverage |
|---|---|---|
| 200 | ≈20 | 91.5% |
| 400 | ≈40 | 92.8% |
| 1,000 | ≈100 | 92.8% |
| 2,500 | ≈249 | 94.8% |
| 6,000 | ≈599 | 95.0% |

Coverage tracks **recovered** control events, not total control events. It
reaches nominal around 250. The reason is straightforward once seen: the
control arm's mean recovered value is estimated from its non-zero
observations, and at a 10% organic rate, `n_control = 300` buys about **30** of
them. Thirty heavily-skewed numbers is not enough to pin down a mean, whatever
the denominator says.

**So `n_control ≥ 300` is measuring the wrong thing.** It reads as a serious
threshold and is satisfied by a sample where the interval is meaningfully too
narrow.

**Fix:** the threshold stays (it is a locked decision and it is not harmful),
but the metric now reports a **caveat** naming the number of recovered control
events and the coverage actually measured at that level. A 3,000-event batch at
an 18% control split cannot reach 250 recovered — so the honest move is to show
the number with its real precision stated, not to refuse to show it, and not to
quietly present 93% coverage as 95%.

BCa was kept: it is the right default for a skewed estimand, and it measured
slightly better on the null case (7.0% vs 7.7% false-positive rate against a
nominal 5%). It is behind a flag so the plain percentile interval stays
available for comparison.

**Cost:** ~50 minutes, and worth every minute — this is the number the project
is judged on.

**What it means:** an estimator can be arithmetically correct and still
overclaim. The unit tests all passed before and after; only a coverage
simulation could tell the difference. Two other things that fell out of the
same session and are now permanent tests: the arm-assignment hash is uniform
across all 100 buckets (χ² = 115.2, 99 df — consistent with uniform), and the
p-value is floored at 1e-16 because `normalCdf` saturates past |z| ≈ 8 and was
reporting **p = 0**, which is a claim of impossibility that no finite sample
can support.

---

## 10. The blueprint's canonical serialiser left the most tamper-worthy field unhashed

**When:** Milestone 5, implementing the audit hash chain.

The blueprint gives the chain in two lines (6.3):

```ts
const canonical = (r: LedgerInput) => JSON.stringify(r, Object.keys(r).sort());
const hash = sha256(prevHash + canonical(record));
```

It looks right. Sorting the keys is exactly the correct instinct — without it,
two logically identical records hash differently depending on insertion order.
I nearly used it as written.

**The second argument to `JSON.stringify` is a replacer, and an array replacer
is an allow-list that applies at every level of nesting.** So for a record like:

```js
{ action: 'send', detail: { rail: 'upi_payment_link', cost_paise: 20 } }
```

the allow-list is `['action', 'detail']`, and because `rail` and `cost_paise`
are not in it, the nested object serialises as `{}`:

```
{"action":"send","detail":{}}
```

**The entire `detail` payload never reaches the hash.** And `detail` is where
everything worth tampering with lives: the rail chosen, the amount, the rules
trace, the operator's stated reason for overriding a circuit breaker. Someone
with database access could rewrite every `detail` field in the table and
`verifyChain()` would report the chain fully intact.

An audit ledger that does not protect the audit trail is worse than no ledger,
because it manufactures confidence.

**Fix:** a real recursive canonicaliser — sorts keys at every depth, preserves
array order (an array is ordered data; sorting would make `['allow','block']`
and `['block','allow']` identical), normalises `-0`, and **throws** on values
JSON cannot round-trip rather than letting `NaN` and `Infinity` silently become
`null`. Hashing a quietly degraded record is worse than refusing to hash it.

The blueprint's one-liner is kept in `canonical.test.ts` as an executable
record of the bug: the test asserts that a tampered `detail` hashes *identically*
under it and *differently* under ours. If anyone ever simplifies the file back
to the one-liner, that test explains what broke.

**Proved rather than asserted.** `npm run ledger:tamper` builds a chain and
attacks it three ways:

```
attack 1  UPDATE via SQL          → refused by the append-only trigger
attack 2  edit a nested detail    → content_edit detected at seq 3
          (the case the one-liner would have missed)
attack 3  delete a middle row     → broken_link detected at seq 4
```

**A second correction, same file.** The blueprint says to `SELECT ... FOR
UPDATE` the head row so concurrent appends cannot fork the chain. Right
instinct, and it does not quite work: `FOR UPDATE` locks rows that *exist*, and
the first append has no head row to lock. Two concurrent genesis appends would
both read "no head", both use the genesis prev_hash, and fork the chain at row
one. Replaced with a transaction-scoped **advisory lock**, which exists whether
or not the row does and releases itself on commit or rollback.

**Cost:** ~40 minutes.

**What it means:** this is the third time in this build that correct-looking
code produced a *plausible* wrong answer rather than an error — after the EWMA
baseline (#3) and the policy gate replaying outside a step (#7). The pattern is
consistent enough to be worth naming: **the dangerous bugs here are the ones
that still return something.** None of them would have been caught by a test
that asserts the code does what the code does; all three needed a test that
asks whether the *claim* is true — does detection still fire, does the gate run
once, does tampering get caught.

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

**Payment Downtime API — verified against the live test-mode API, and the
planning assumption was wrong.** See #6 below. The endpoint is
`GET /v1/payments/downtimes` (plural), it returns **200 on test-mode keys**, and
it covers `netbanking`, `card`, `upi` and `fpx` — not `card`/`ach` only as the
kickoff brief recorded. `downtime_api_agrees` is still `NULL` rather than
`false` when there is no signal for a cohort: "no signal" and "disagreed" are
different facts and the agreement scorecard must not conflate them.

**Cohort counters live in Postgres, not Redis.** The blueprint specifies a Redis
sorted set for the 15-minute rolling decline rate. Upstash is not provisioned, so
`cohort_counters` / `cohort_baselines` are Postgres tables behind a `CohortStore`
interface. Correctness is identical; latency is worse; the swap is one file.

**The rupee interval is approximate at demo scale.** Measured coverage is
~93% against a nominal 95% when the control arm has fewer than ~250 recovered
events, which a 3,000-event batch cannot reach. Reported as a caveat on the
result itself. See #9.

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
