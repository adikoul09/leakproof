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

## 11. The blueprint's EWMA baseline maintenance destroys outage detection

**When:** Milestone 6, tuning the detector against the generator's injected outage.

FAILURES #3 was the same mistake one level down: advancing the EWMA baseline
once per *classified event* let a live outage teach the baseline that outages
are normal. The fix was to move baseline maintenance to the `outage.detect`
cron, where it can look at completed windows instead of a live spike. That is
what the blueprint specifies, and it is what I intended to build.

With a generator and a ground truth I could finally measure it instead of
reasoning about it. `npm run tune:triage` replays the corpus twice — once with
the baseline frozen at its seeded prior, once advancing the EWMA from each
*closed* 5-minute bucket, which is the careful version:

```
seeded    n≥8 3σ floor 0.25   precision 77.4%   recall 96.7%   tp 1140 fp 339 fn 43
adaptive  n≥8 3σ floor 0.25   precision 31.3%   recall  0.8%   tp   10 fp  22 fn 1173
```

**Recall collapses from 97% to 0.8%.** The careful version is catastrophically
worse than not doing it at all.

The mechanism is sampling noise, not contamination. A 5-minute bucket on a real
cohort holds about six attempts. At a true decline rate of 13%, a six-sample
proportion has a standard deviation near 0.14 — so the bucket-to-bucket rate
genuinely bounces between 0 and 0.33 with nothing wrong. The EWMA cannot tell
that variance from real volatility, absorbs it as σ, and the 3σ threshold climbs
to roughly `0.13 + 3(0.14) = 0.55`. The injected outage runs at 0.62 and the
window rate is diluted at its edges, so almost nothing ever clears the bar.

**An EWMA over observed proportions has no idea how many samples each
proportion was computed from.** That is the whole bug. The seeded prior wins
precisely because its σ = 0.05 is an *assumption* about how much a cohort's
decline rate really moves, rather than a measurement contaminated by
small-sample noise.

**Fix:** do not build it. `updateBaseline` stays implemented and stays uncalled,
with the measurement written into `config.ts` next to `seedBaselineRate` so the
next person to notice the dead code finds the reason before deleting it.

The principled version is a **one-sided binomial test** — is this window's
failure count improbable under the baseline rate *given n* — which handles small
samples by construction instead of hoping σ absorbs them. That is a real
improvement and it is not built; it is a redesign of the detector's core test,
and the build order says ship. Recorded here as the honest next step rather than
as a nice-to-have.

---

## 12. The three-guard systemic test is two guards

**When:** Milestone 6, reading the threshold sweep.

The blueprint's systemic test has three guards: `cohort_n ≥ 8`, `rate > baseline
+ 3σ`, and `rate > 0.25 absolute`. I implemented all three, wrote a test
asserting all three must pass, and moved on.

The sweep varied `sigmaMultiplier` from 1.5 to 4 across every combination of the
other two and the scores were **identical**. Under the seeded prior the σ
threshold is `0.08 + k × 0.05`; at the deployed `k = 3` that is 0.23, which sits
*below* the 0.25 absolute floor. The floor always binds first, so the σ test
never changes an outcome. It only starts to matter past `k ≈ 5.4`.

Nothing is broken — but "three independent guards" is a claim about the system,
and it was not true. A demo that says "all three must pass" while one of them
provably cannot fail is overstating the design.

**Fix:** the tuner detects this and prints it every run, so it cannot quietly
become true again after someone retunes the floor. `config.ts` says it at the
constant. The guard is kept rather than deleted: it binds on any cohort whose
baseline has genuinely been measured, and the day the detector gets a real
baseline it starts doing work.

---

## 13. The detector's thresholds missed the blueprint's own bar

**When:** Milestone 6. This one was on the list from milestone 1 and stayed
open for five milestones.

The blueprint is explicit that `n≥8`, `3σ`, `0.25` are assumptions and must be
tuned until precision and recall both clear 0.8. Measured against 1,165
ground-truth systemic events across six seeded corpora, the shipped defaults
scored:

```
precision 77.4%   recall 96.7%   8.8 false alarms per 1,000 failures
```

**It missed the bar** — and it missed on precision, which is the expensive side
here. A false systemic call parks a recoverable payment behind the circuit
breaker, so on this product a false positive costs real revenue by *declining to
act*. The system was over-eager in the direction that quietly loses money.

The sweep's single best configuration by F1 was `minCohortN 24` (F1 0.961). I
did not take it. Requiring 24 attempts in a 15-minute window before a cohort can
be judged at all means the detector scores beautifully on this corpus and is
permanently blind at any merchant quieter than it — buying precision by
declining to look.

**Fix:** hold `minCohortN` at 8 and raise the absolute floor from 0.25 to 0.35.

```
floor 0.25   P 77.4%  R 96.7%   8.83 false alarms/1k   detection lag 153s
floor 0.30   P 87.1%  R 95.3%   4.40 false alarms/1k   detection lag 232s
floor 0.35   P 94.6%  R 93.6%   1.69 false alarms/1k   detection lag 346s   ← shipped
floor 0.45   P 98.4%  R 91.3%   0.47 false alarms/1k   detection lag 442s
```

The price is detection lag: 153s → 346s. Five minutes into an outage rather than
two and a half. Worth it to cut false alarms by 5×.

`npm run tune:triage` exits non-zero if the deployed configuration misses the
bar, so this cannot silently regress.

---

## 14. My own generator's ground truth was the estimator marking its own homework

**When:** Milestone 6, writing the incrementality scorecard.

The first version of the generator reported ground-truth incremental revenue as
`n_treated × (mean recovered value treated − mean control)` — computed off the
corpus it had just emitted. Comparing the estimator's output to that would have
shown a near-perfect match on every run, because **it is the same formula**. It
would have proved the arithmetic ran twice.

**Fix:** make the ground truth counterfactual. Recovery is decided by a *single*
uniform draw `u` per event:

```
recovers              when  u < organic + uplift
would have anyway     when  u < organic
caused by treatment   when  organic ≤ u < organic + uplift
```

So the generator knows, per event, whether that recovery was *caused* by the
treatment. Two independent draws would have made this unknowable.

The first honest comparison was uncomfortable. On one 24-hour seed:

```
true incremental (counterfactual)   ₹8,97,066   over 243 caused recoveries
sample difference in means          ₹2,37,201
```

**A 3.8× gap**, driven entirely by which arm happened to catch the largest
tickets — the control arm's 56 recoveries included a couple of enormous ones and
dragged its mean up. Over the same corpus the *rate* lift was accurate to within
a percentage point (12.15pp measured against 12.85pp true).

This is not a bug in the estimator. `n × (mean_t − mean_c)` is unbiased; it is
just very high variance on a log-normal ticket distribution at this sample size.
But it means **the rupee point estimate is not the number to lead with**, and
the BCa interval is not decoration. `GET /api/simulator/batches/:id` now reports
whether the interval covered the planted truth, which is the only version of
this check worth running.

---

## 15. A duplicate webhook was counted twice in the cohort — a bug I wrote this milestone

**When:** Milestone 6, first end-to-end run of a generated batch.

The pipeline started throwing `duplicate key value violates unique constraint
"recovery_attempts_event_attempt_uq"`. Two `recovery.plan` runs were racing into
the same `(event_id, attempt_no)`.

Batching the ingest for speed introduced it. The old path handled one event at a
time and `insertPaymentEvent` returned false for a redelivery. The bulk version
inserts the chunk, gets back the set of ids that were genuinely new, and then
walks the chunk:

```ts
const newIds = await insertPaymentEvents(chunk);
for (const e of chunk) {
  if (!newIds.has(e.id)) continue;
  observations.push(...);      // cohort counter
  queuedForTriage.push(e.id);  // Inngest
}
```

A byte-identical redelivery **inside the same chunk** appears twice in `chunk`.
The insert collapses it to one row, so `newIds` contains the id — and the loop
therefore fires twice for it. The crash was the loud symptom. The quiet one
mattered more: **the cohort's failure count was inflated by every duplicate
delivery**, and the cohort decline rate is the direct input to the systemic
detector. Duplicates would have been manufacturing outages.

**Fix:** a `counted` set inside the flush. Three lines.

Two things about this are worth saying. First, the generator found it — this is
exactly the adversarial case the corpus is built to contain, and it found the
bug on the first real run. Second, it would have been invisible without the
unique constraint: the cohort inflation produces no error, just a slightly wrong
number in the direction that makes the demo look more exciting.

---

## 16. The generator reported 73 out-of-order deliveries when it had emitted 8

**When:** Milestone 6, writing the generator's tests.

`out_of_order_recovery` is one of the adversarial traits: the success arrives
before the failure it resolves. The generator marked it on a share of failures
and counted it in the summary at the point of marking — but the trait can only
be *realised* on an event that actually recovers, and only ~13% do. So the
summary claimed 73 out-of-order deliveries in a corpus containing 8.

A generator that misreports its own corpus is worse than one that does not have
the feature, because everything downstream is scored against that summary.

**Fix:** decide recovery *before* assigning hostile traits, so
`out_of_order_recovery` is only ever assigned to an event that will emit one.
When the redraw lands on a non-recovering event it picks from the four
order-free kinds instead, so the adversarial share still comes out exact.

The first fix was wrong too, and the test caught it:
`ADVERSARIAL_KINDS[intBetween(rng, 0, ADVERSARIAL_KINDS.length - 2)]` still
includes `out_of_order_recovery` — it is at index 2, and `length - 2` is 3, so
the range 0..3 covers it. Off by one in a fix for a counting bug.

---

## 17. The recovery rail rate-limited itself off Razorpay

**When:** Milestone 6, first full batch through the live pipeline.

A 600-event synthetic batch put a few hundred payment-link creations into flight
at once and Razorpay started returning `Too many requests`. Nothing was lost —
429 is already classified retriable and Inngest retried — but this is a real
production failure mode, not a simulator artefact.

**A recovery rail that DDoSes its own provider under load will fail during an
outage**, which is precisely when every failed payment arrives at once and every
one of them wants a link. The load pattern that broke it is the load pattern the
product exists for.

**Fix:** `concurrency: { limit: 5 }` and `throttle: { limit: 40, period: '1m' }`
on `recovery.execute`. Inngest holds the queue durably, so throttling costs
latency rather than work — a sleep inside the function would have occupied a
worker for the same delay.

---

## 18. `db:migrate` reported success and applied nothing

**When:** Milestone 6, adding the simulator tables.

Migrations in this repo are hand-written SQL, because two of them do things
`drizzle-kit generate` will not emit (the audit ledger's append-only trigger,
`IF NOT EXISTS` guards). I wrote `0003_simulator.sql`, ran `npm run db:migrate`,
got `migrations applied`, and moved on.

The tables were not there. Drizzle's migrator reads `drizzle/meta/_journal.json`
to decide what to run, not the directory listing — so an SQL file with no
journal entry is invisible, and applying zero migrations is a successful run.

**Fix:** add the journal entry. Recorded because it is a silent-success failure,
the category this project keeps finding: nothing errored, the tool reported the
outcome I wanted, and the only way to notice was to check the database for a
table I had just been told was created.

---

## 19. The pipeline erased every recovery it had just recorded, and disarmed the "they already paid" rule

**When:** Milestone 6, reading the first complete batch's scorecard.

Detection scored 95.2% precision. Then, two lines down:

```
planted_incremental_paise    10842800
measured_incremental_paise   0
ci95_paise                   [0, 0]
```

The batch contained 85 real recoveries. The system reported zero.

`recovered_at` and `recovered_paise` were correct on all 85 rows. Only `state`
was wrong — not one row said `recovered`:

```
by state:   deferred 472 (66 with recovered_at)
            at_risk  120 (8  with recovered_at)
            blocked_by_policy 61 (11 with recovered_at)

recovered_at set but state <> 'recovered':  85 of 85
```

**Every stage of the pipeline wrote `state` unconditionally.** A recovery is
recorded during ingestion; `triage.classify` was queued *before* that recovery
arrived, and when it finished it ran its `settle-state` step and put the event
back to `at_risk`. Later `recovery.plan` moved it to `deferred`. Each job was
doing exactly what it was written to do. The event was recovered, then quietly
un-recovered by a job that had started earlier and finished later.

Nothing errored. Not one line of anything looked wrong.

**The metric was the second-worst consequence.** The first is that
`stop_on: payment_success` reads the state:

```ts
if (state === 'recovered') fired.push('payment_success');
```

So the rule that stops LEAKPROOF contacting a customer who has **already paid**
was silently disarmed for every recovered event in the batch. It never fired
once — `policy_evaluations` mentioning `stop_on`: zero. Nobody was actually
contacted here only because 4 September 2026 is Janmashtami and the gate
deferred all 472 attempts to the next working day. On any other date this batch
would have chased hundreds of customers for money they had already sent.

Which is the whole product, inverted. The thing LEAKPROOF exists to avoid.

**Fix, in two parts, because one is not enough.**

*A terminal state is terminal.* `setEventState` adds `AND state NOT IN
('recovered','lost','stopped')` to every transition, and all six unguarded
writes across four jobs now go through it. `state.ts` holds `OPEN_STATES` and
`TERMINAL_STATES` side by side, and `state.test.ts` asserts they partition
`event_state_t` exactly — so adding a state and forgetting one of the lists
fails the suite instead of silently making recoveries unmatchable.

*The metrics read the fact, not the label.* `recovered_at` is a timestamp
written once by the code that recorded the money. `state` is a label four
different jobs write. The number that decides whether this project worked should
not depend on a label winning a race, so `loadArms`, the timeseries and the
rollup now all key off `recovered_at IS NOT NULL`.

The second fix was verified against the corrupted data itself — no re-run, no
repair. Same 653 events, same clobbered states:

```
planted lift (realised)       9.39pp
measured lift                 9.3917pp
planted incremental        ₹1,08,428   (counterfactual)
measured incremental         ₹52,559
95% interval          [−₹2,20,633, ₹1,62,915]   covers the truth ✓
powered: false — "control arm has 120 events, needs 300"
```

**Found only because the generator knew the answer.** Everything upstream was
green: 653 events ingested, 653 classified, 95.2% precision, zero errors in the
logs, a dashboard that would have looked healthy. The single thing that caught
it was a corpus that could say "there were 85 recoveries here" while the system
said zero. That is the argument for the generator being a first-class citizen
rather than a fixture, and it is the fourth time on this project that the
dangerous bug returned a plausible wrong answer instead of an error — after the
EWMA baseline (#3), the replaying policy gate (#7) and the unhashed `detail`
field (#10).

---

## 20. The 15-minute cohort window had no upper bound, and was reading the future

**When:** Milestone 8, on the first replay run. Found by the replay engine, not
by a test.

The replay reported 42 systemic classifications against the 35 history had
recorded — under the *same* policy and the *same* thresholds. Nothing about the
what-if should have moved that number, so something was wrong with one of the
two runs.

The rolling window is defined as "the last 15 minutes of this cohort's counter
buckets". The query implementing it:

```ts
const from = new Date(bucketStart(at).getTime() - (windowMinutes - bucketMinutes) * 60_000);
...
.where(and(eq(cohortCounters.cohortDim, cohortDim), gte(cohortCounters.bucketStart, from)));
```

**A lower bound and no upper bound.** It sums every bucket from `from`
*forward*, for ever.

On live webhook traffic this is invisible, because the future has not happened
yet — there are no buckets after `now` to sum. It only bites on anything
backfilled, and the generator backfills by construction: a demo batch pushes 24
hours of events through the pipeline in eight minutes. By the time triage
reached an event stamped 03:00, the counters already held 04:00 through midnight.

So a "15-minute window" was returning this:

```
cohort_key            cohort_n   decline_rate
SBI|upi|<500|230        3,387       0.0803
```

**n = 3,387 for fifteen minutes, at exactly the whole day's average decline
rate.** Two consequences, both quiet:

- The `cohort_n >= 8` guard stopped meaning anything. Every cohort trivially
  cleared a threshold designed to suppress small-sample noise.
- A real spike was averaged into the daily mean and **suppressed**. An outage
  running at 62% for 45 minutes, diluted across a day at 8%, never clears the
  0.35 floor.

The injected outage was still detected, and that is the uncomfortable part. It
sits at the *end* of the corpus, so for those events "everything from here
forward" happens to be almost entirely outage buckets — the window was
accidentally right precisely where it was being measured. Detection scored 91%
precision on the demo batch **for the wrong reason**, and an outage placed in
the middle of the window would have been missed silently.

**Fix:** bound both ends, in the Postgres store and the in-memory one.
`cohort-window.test.ts` locks it down with four assertions, including one that a
spike stays a spike instead of being diluted by the rest of the day.

The tuner was unaffected and its numbers did not move by a single event —
`npm run tune:triage` replays in timestamp order and observes as it goes, so the
future buckets never existed to be read. That is the accidental benefit of
building the tuning harness as a replay: it was already doing the honest thing,
and its agreement before and after the fix is the evidence the fix is right.

**What found it.** Not a test — every test asserted the window code does what
the window code does. It was the replay engine disagreeing with history about a
number neither of them should have been able to change. Building the second
consumer of a function is what exposed it, which is the fifth time on this
project the dangerous bug returned a plausible wrong answer instead of an error.

---

## 21. Replay compared "messages authorised" against "messages actually sent"

**When:** Milestone 8, same run.

The first replay reported a delta of **+1,624 contacts and +₹233 of spend**
against a policy that had not changed. The screen would have shown a dramatic
policy effect that was pure artefact.

The baseline counted contacts from `messages` rows — what had physically been
sent. The replay counted them from the *gate verdict* — what the policy
authorises. Those are different quantities, and 4 September 2026 is Janmashtami:
the gate had correctly deferred all 1,494 attempts to the next working day, so
nothing had been sent at all. Baseline zero, replay 1,624, and the difference
was entirely "tomorrow has not happened yet".

**Fix:** derive both sides from the decision, priced through the same
`railCost`. And a second problem the fix exposed — 258 of the 3,000 events had
no recorded gate verdict at all, because triage was still draining. Replay
evaluates those; history has nothing to compare them to. They are now excluded
from every delta and reported as `events_without_baseline_decision`, so a
partially-drained corpus cannot masquerade as a policy effect either.

A third confound survives and is surfaced as a caveat rather than fixed: the
stored classifications were produced by whatever code was live when each event
was ingested. After #20, replaying the same corpus under the same policy shows
+33 systemic — which is measuring the *window fix*, not the policy. The engine
now detects a swing of that size and says so, because a what-if screen that
silently attributes a code change to a policy change is worse than no screen.

---

## 22. The detector was tuned at one volume and did not survive the volume it ships at

**When:** Milestone 8, immediately after fixing #20 and re-running the numbers
for real.

Fixing the cohort window changed what the detector sees, so the classifications
already in the table were stale. Re-running them over the demo batch — 3,049
events, 100% of ground truth scored for the first time — gave:

```
precision 73.8%   recall 81.6%
```

**Precision below the bar**, on a detector I had reported at 94.6% one milestone
earlier. The earlier number was partly #20 flattering it, but not entirely.

The tuner still said 94.6%. Both could not be right, so I ran the tuner at the
demo preset's actual parameters — 3,000 failures a day, a 45-minute outage —
instead of the ones it had been using:

```
tuned at   6,000 failures/day, 90-minute outage   P 94.6%  R 93.6%
shipped at 3,000 failures/day, 45-minute outage   P 78.0%  R 86.8%
```

**I tuned on a corpus with roughly four times the systemic signal of the one the
product actually generates.** A thinner corpus means smaller cohorts, and a
cohort of 8 attempts throws a false alarm whenever three of them happen to fail
together — which at a 13% base rate is not rare at all.

The irony is exact. In milestone 6 I explicitly refused to raise `minCohortN` to
24, on the argument that it "would score beautifully here and be permanently
blind in production". That argument was right. I then made its mirror image:
kept `minCohortN` low and tuned everything else against a corpus that was never
thin, so the low threshold was never actually tested where it hurts.

**Fix, in the harness first.** `npm run tune:triage` now sweeps four scenarios —
3k/day with a 45-minute outage, 6k/day with 90, 3k/day with a *20*-minute
outage, and a dense 6-hour window — and scores a configuration at its **worst**
scenario, not its average. Averaging would let a strong result at high volume
paper over a failure at the volume the demo runs at, which is the exact mistake
being fixed.

That immediately exposed which case actually binds, and it is not the one I had
been tuning against:

```
                              n≥8, floor 0.35        n≥16, floor 0.30
demo   3k/day, 45m outage     P 80.3%  R 86.3%  ✓    P 94.2%  R 89.0%  ✓
busy   6k/day, 90m outage     P 94.6%  R 92.9%  ✓    P 96.6%  R 93.9%  ✓
brief  3k/day, 20m outage     P 64.8%  R 76.0%  ✗    P 84.7%  R 81.3%  ✓
dense  4k/6h,  180m outage    P 99.0%  R 97.0%  ✓    P 99.3%  R 97.4%  ✓
```

A brief outage in a thin corpus is the hard case, and it is also the most
ordinary thing that happens to a payment gateway. It was not in the tuning set.

**Shipped: `minCohortN 16, absoluteFloor 0.30`.** Raising the small-sample guard
and *lowering* the floor beats doing either alone — with `minCohortN` carrying
the noise problem, the floor no longer has to, and the recall a high floor was
costing on brief outages comes back. Detection lag improved too, 349–401s down
to 234–326s, because a lower floor trips sooner.

On the live 3,049-event batch, re-classified: **precision 83.3%, recall 92.1%**,
scoring 100% of ground truth rather than the 94.7% the half-drained run managed.

The threshold is validated between roughly 3,000 and 6,000 failures a day.
Below that it is unvalidated and `minCohortN` is the first thing to lower —
stated here rather than discovered by someone with quieter traffic.

`classifier.test.ts` no longer hardcodes `>= 8`; it derives its fixtures from
`TRIAGE`, because a test that pins yesterday's tuned constants fails for the
wrong reason and teaches everyone to edit tests when they retune.

---

## 23. The WhatsApp rail created a payment link and told nobody about it

**When:** Milestone 8, doing an honest pre-pitch audit of what is actually wired.

Delivery in this system is Razorpay's own notification on the payment link:

```ts
notify: { sms: channel === 'sms', email: channel === 'email' }
```

That is what makes the recovery rail end to end without provisioning a separate
email or WhatsApp provider, and it is a good trade. But **Razorpay has no
WhatsApp notification**, and `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` were
never configured — there is no Meta Cloud API client in the codebase at all.

So for `rail = whatsapp_nudge`, `channel` is `'whatsapp'`, and both flags
evaluate false. The link gets created. Nobody is notified. And the code then:

- marks the event `action_sent`,
- writes a `messages` row with the WhatsApp template body and `sent_at` set,
- bills `whatsapp_utility_message` into cost-per-₹100-recovered.

**312 of the 1,672 attempts on the demo corpus — 19% — routed to that rail.**
The dashboard would have reported nearly a fifth of its actions as sent when
nothing had left the building, and charged for them.

Nothing errored, which is the pattern this project keeps running into. It is
also the worst version of it so far: the previous silent-wrong-answer bugs
corrupted a *number*, and this one corrupts the thing the number is about. An
uncontacted customer counted as contacted does not just mis-measure recovery, it
quietly converts a treatment event into an untreated one — and since the
incrementality result rests on treated arms actually being treated, it would
have biased the headline toward zero while every screen said the send succeeded.

It has not corrupted any result yet only by accident: 4 September is a bank
holiday, the gate correctly deferred all 1,672 attempts to the next working day,
and **not one of them has executed**. The bug was found before it could fire.

**Fix:** `effectiveChannel(rail, whatsappConfigured)`. Until a WhatsApp provider
exists, a WhatsApp rail degrades to SMS — the same phone number, a channel that
actually delivers — and is recorded as `sms` so the cost meter and the Decision
Trace both say what really happened. The downgrade is a decision about who the
customer hears from, so it writes a `channel_degraded` ledger record rather than
a log line.

`channel.test.ts` asserts the fallback, that no other rail is touched, and that
**no rail can resolve to a channel with no delivery path** — which is the
general form of the bug and the assertion that would have caught it.

The rail stays in the routing table. When credentials arrive, one boolean flips
and `whatsapp_nudge` starts genuinely using WhatsApp.

---

## 24. The agreement scorecard would have reported zero for a spelling reason

**When:** Building `outage.detect` (M3), the cross-check against Razorpay's
Payment Downtime API.

The cross-check is the only external corroboration this project claims, so it
matters that a low agreement number means "the detector was wrong" and not
something else. The first version matched a cohort to a downtime row by issuer
string. Against the live test-mode feed:

```
our cohorts      HDFC   ICICI   SBI    AXIS   KOTAK   PNB    BOB
the feed says    HDFC   ICIC    SBIN   UTIB   KKBK    PUNB   BARB
```

**Razorpay reports issuers as IFSC bank codes; we label them by common name.**
Of the fifteen issuers the generator produces, exactly two — HDFC and Citi —
are spelled the same in both vocabularies. Every other bank would have failed to
match *even when Razorpay had flagged the same outage*, and the scorecard would
have reported near-zero agreement as though the detector were wrong.

**Fix:** an alias table, and a test that asserts `checkDowntime` matches
`ICICI` against a feed row reading `ICIC`.

**And a second, worse version of the same mistake.** The verdict is
three-valued — NULL when the feed has no rows for the method at all, `false`
when it covers the method and did not flag this cohort. But the scorecard
computed "did the feed have an opinion?" by checking whether a downtime row had
been matched, and a `false` verdict has no row to point at. So every window the
feed genuinely disagreed with was dropped from the denominator, and:

```
per-window:   agrees = false  (six times)
scorecard:    windows_feed_had_an_opinion_on: 0,  agreement_rate: null
```

The screen contradicted itself. Worse, it contradicted itself in the flattering
direction — an agreement rate of `null` reads as "not enough data yet", while
the truth was six recorded disagreements. Fixed by persisting the verdict on the
window (`downtime_api_agrees`, three-valued, plus the reason in words) instead
of re-deriving it from a join that cannot represent it.

**What it reports now, and why that is the right answer:**

```
windows 6 · feed had an opinion on 6 · agreement_rate 0
HDFC|card  36 events  peak 0.68  ₹1,46,968 parked
           "feed covers card (4 rows) but did not flag HDFC"
```

Zero agreement is **correct**. The outage is one my own generator injected;
Razorpay's feed cannot corroborate something that never happened. The machinery
is wired, it runs, it records — and on synthetic traffic it honestly reports
that nobody else saw the incident. The agreement number only becomes meaningful
against real traffic, and the scorecard says which windows the feed had an
opinion on so nobody can quote the rate without that context.

A test also asserts that `classify()` contains no reference to downtime data at
all. If the feed ever reaches the classifier the validation becomes circular and
the agreement number stops meaning anything, and that is worth failing a build
over.

---

## 25. WhatsApp cannot send, and the second reason is architectural

**When:** Executing the WhatsApp timebox after the audit.

Two blockers, and only the first is the one anybody expects.

**Clerical:** `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` are unset. That
needs a Meta Business account, a verified sender number, and a business-initiated
template approved by Meta — a WhatsApp conversation started by the business
outside the 24-hour service window must use one, or Graph rejects it with error
131047. Payment recovery is business-initiated by definition: the customer's
last action was a failed payment, not a message to us.

**Architectural, and more interesting:** *this system has nowhere to send to.*

Every other rail is delivered by Razorpay's own notification on the payment
link — `notify: {sms, email}`. **Razorpay** holds the customer's contact
details, which is exactly why LEAKPROOF never has to. `customers` stores
`phone_hash` (sha256) and `phone_masked` (`+91••4821`) and nothing else. Raw PII
is never written, anywhere, on purpose.

Meta's Cloud API has no such arrangement. Sending a WhatsApp message means
holding an E.164 number, which means storing raw contact details for every
at-risk customer in the system. **That is a privacy decision, not a
configuration one**, and it is not one to make quietly at 11pm the night before
a demo because a rail in a routing table asked for it.

So the timebox produced: the client, written and tested — template sends,
three-way error classification, phone normalisation that refuses a number it
cannot parse rather than mangling it, and a health probe that reads the sender's
own metadata (the cheapest authenticated call that proves token and number id
agree, and messages nobody). Wired into `recovery.execute` behind
`effectiveChannel`, which now returns *both* blockers separately and in words:

```
whatsapp_nudge resolves to: sms · degraded from: whatsapp
reason: WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID are not configured
blockers:
  - Meta Business credentials: token, phone number id, verified sender,
    approved business-initiated template.
  - A deliverable phone number. This system stores only sha256 hashes and
    display masks; Razorpay holds the real contact and notifies on our behalf,
    which is why the other rails need no PII. WhatsApp would require storing
    raw numbers — a privacy decision, not a configuration one.
```

`whatsappBlockers()` returns them as two separate strings and a test asserts
both are named, precisely so the architectural one cannot be mistaken for the
clerical one when someone reads "WhatsApp isn't set up" and assumes an
afternoon's work.

When credentials arrive, one boolean flips and the rail sends — but only for
customers whose numbers we have chosen to store, and that choice has to be made
deliberately first.

---

## 26. The entry screen nearly became a second polling client

**When:** Milestone 9, building `/` as a real screen instead of a redirect to
`/tower`.

**Symptom:** none, at first. The entry screen fetches `/api/metrics/summary` and
`/api/ledger/verify` so its figures are live rather than illustrative, and both
went into the same 15-second `setInterval`. It looked fine locally.

**Diagnosis:** `/api/ledger/verify` is not a read. It walks the entire chain and
rehashes every record — 8,514 of them at the time, and it was measured at 3.7–6.7
seconds per call. On one deployed instance shared by several judges, a landing
page left open in a background tab would have re-run a multi-second full-table
scan every fifteen seconds per tab, against the same database the Control Tower
polls every five. The tower would have got slower the more people looked at the
front page.

**Fix:** the chain is verified exactly once, on mount, and only the metrics
summary stays on the interval. The badge is still a real verification — that is
the whole point of putting it there — but it is a verification, not a
heartbeat.

**Cost:** ~5 minutes, all of it before it could cost anything.
**What it means:** a cheap-looking `fetch` on a marketing-ish surface can be the
most expensive query in the system. The rule that came out of it: anything on a
public, always-open screen gets its cost checked before it gets a timer.

---

## 27. Display type clipped its own descenders on a phone

**When:** Milestone 9, checking the entry screen at 390px.

**Symptom:** the headline's second wrapped line was shaved along the bottom — the
baseline of "revenue." was visibly cut. Only on narrow viewports; invisible at
every desktop width.

**Diagnosis:** the mask-reveal effect works by wrapping each headline line in an
`overflow: hidden` box and sliding the text out of it. At desktop sizes each line
is one line and the `0.08em` of bottom padding cleared the descenders. On a phone
the same line wraps to two, and the clip box — sized to the text — cut the second
row.

**Fix:** more bottom padding on the clip box, plus the eyebrow's second phrase
is dropped below `sm` rather than allowed to wrap into three ragged lines at
0.22em tracking.

**Then it got worse.** Switching the headings to Instrument Serif deepened the
descenders — Next reports the face at 36.9% below baseline against Inter's
22.5% — and `0.14em` started shaving the `y` of "you." at *every* width, not
just narrow ones. Raising it to `0.2em` fixed the clipping and opened a visible
gap between the two stacked headline lines, because that padding is real layout
space. The answer was `padding-bottom: 0.2em` with `margin-bottom: -0.15em`:
the clip box stays tall enough for the descenders, and the next line is pulled
back up through padding that is empty by construction.

**Cost:** ~10 minutes, found by screenshotting the page at 390px rather than by
assuming it was fine.
**What it means:** clipping is how every mask-based type animation works, so
every one of them is a wrapping bug waiting for a narrow viewport. Checked at
390, 1440 and 1600, and with `prefers-reduced-motion: reduce` — where the risk is
the opposite one, elements that start at `opacity: 0` and never animate to
visible. They resolve correctly because the reveals are animations with
`fill-mode: both`, not transitions: the reduced-motion rule collapses the
duration but the end state still applies.

---

## 28. A timestamp Postgres calls ISO-8601 that JavaScript calls Invalid Date

**When:** Milestone 10, building the Incrementality Lab's cumulative chart.

**Symptom:** the chart drew correctly — three lines, right shape, right values —
and both x-axis labels read `—`. Nothing threw, nothing logged, and the page
looked finished.

**Diagnosis:** `/api/metrics/timeseries` formatted its bucket with Postgres's
`OF` offset pattern:

```sql
to_char(date_bin(...), 'YYYY-MM-DD"T"HH24:MI:SSOF')   -- 2026-09-03T10:00:00+00
```

`OF` emits only as much of the offset as it needs, so a zero-minute offset comes
out as a bare `+00`. ISO-8601 requires `+00:00` or `Z`, and V8 agrees:
`new Date('2026-09-03T10:00:00+00')` is `Invalid Date`. My `istLabel` helper
guarded with `Number.isNaN(d.getTime())` and returned `—`, which is the correct
behaviour for a bad date and the reason nobody would ever find this. Everything
downstream of the *sort* still worked, because sorting the strings
lexicographically happens to be right.

The API's own contract said this was wrong: the project convention is
"timestamps ISO-8601 with offset", and `+00` is not.

**Fix:** pin the bucket to UTC and write a literal `Z`, which is unambiguous
whatever the server's `TimeZone` is set to:

```sql
to_char(date_bin(...) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
```

Fixed at the source rather than normalised in the chart, so every future
consumer of the endpoint gets a parseable timestamp instead of inheriting the
bug and writing its own patch.

**Cost:** ~10 minutes, found by looking at a screenshot.
**What it means:** the third time on this project that a defect surfaced as a
plausible-looking placeholder rather than an error — an em-dash is exactly what
an empty axis is supposed to look like. It was found by rendering the page and
looking at it, which is the only technique that has ever caught this class here.

---

## 29. A disclosure that quietly stopped being true

**When:** Milestone 10, an hour after writing the Lab's provenance banner.

**Symptom:** the banner is the most important thing on the Incrementality Lab —
it says the corpus is synthetic and that the lift is a planted treatment
response being recovered, not evidence a message caused a payment. It rendered
the *milder* half of its wording, and I only noticed because I was diffing a
screenshot against what I had written.

**Diagnosis:** I had keyed the strong wording on a binary:

```ts
const nothingSent = provenance.messages_sent === 0 && provenance.attempts > 0;
```

When I wrote it, `messages` had zero rows. While I was building the rest of the
screen the Inngest queue drained its first five attempts, `messages_sent` became
5, and the banner silently switched to a softer sentence — on a corpus where
1,667 of 1,672 attempts still had not been delivered. The threshold was doing
the reasoning, and nothing was watching the threshold.

**Fix:** the banner no longer branches. It states the counts and lets the reader
draw the line: *1,672 recovery attempts planned · 5 delivered (0.3%) · 5 messages
sent to a real channel.* The interpretation above it is unconditional, because on
a synthetic corpus it is true regardless of how many messages went out — the
recoveries were decided by the generator's uniform draw, not by delivery.

**Cost:** ~10 minutes.
**What it means:** a caveat with a condition on it is a caveat that can turn
itself off. The same shape as #19 and #20 — a claim that stays legible while
quietly ceasing to be accurate — except this time the claim was the honesty
disclosure itself, which is the worst possible place for it. Disclosures get
counts, not conditionals.

---

## 30. `next build` while `next dev` was running, and the page came back unstyled

**When:** Milestone 10, screenshotting the two new screens.

**Symptom:** `/lab` rendered as raw unstyled HTML — correct content, correct
copy, no CSS whatsoever. Then the production server I started to work around it
died with `Cannot find module './vendor-chunks/@opentelemetry.js'`.

**Diagnosis:** `next dev` and `next build` share `.next/`. Running the build
against a directory a dev server was actively serving from left both processes
reading half of each other's output. The dev server's stylesheet 404'd —
`/_next/static/css/app/layout.css` returned 9 bytes of nothing — while the HTML
still linked to it, so the browser got a complete page with no styles and no
console error worth noticing.

**Fix:** stop the dev server, `rm -rf .next`, restart. Both screenshots were
retaken against a clean server.

**Cost:** ~15 minutes and two screenshots that showed nothing useful.
**What it means:** the first two screenshots were not evidence, and I nearly
read them as "the CSS is broken" and started debugging Tailwind. The tell was
that the *content* was perfect — a styling bug that leaves every element in
place and every string correct is usually not a styling bug. Also worth
recording because the user's dev server was collateral damage: builds and dev
servers do not share a working directory.

---

## 31. The panel built to show the values compared showed neither

**When:** Milestone 10, reported as "text is overflowing its box" in the
decision trace drawer.

**Symptom:** three things at once in the Policy gate card, only one of which was
the reported one.

1. `stop_on`'s expected value is `none of payment_success,customer_opt_out,
   complaint_keyword_detected,refund_issued` — 72 characters with no spaces,
   so one unbreakable token. The value column had `min-w-0 flex-1` but no
   `break-words`, and it ran off the right edge of the drawer.
2. `max_contacts_per_customer_per_week` is 34 characters in a `w-[190px]`
   fixed column with nothing allowing it to wrap, so it printed straight
   **over** the "expected 2 · actual 0" beside it. Two overlapping strings.
3. And the one that actually mattered: `bank_holiday` displayed as
   `✗ expected · actual`, with both values simply absent.

**Diagnosis of (3):** `RuleTrace` declared `expected: string; actual: string`.
The values are not strings — they are `'closed'`, `3`, and `false`, whichever
the rule compares. **React renders a boolean `false` as nothing at all**, so
`expected {r.expected}` produced the literal word "expected" followed by empty
space. Every boolean rule — `customer_opt_out`, `bank_holiday` — lost both
sides of its comparison, and a *failing* rule showed a red ✗ with no stated
reason. The README calls this drawer "the screen that has to survive scrutiny"
and claims it shows "the values actually compared". For a third of the rules it
was showing neither.

The wrong type is what hid it: TypeScript was satisfied, because a declared
`string` cannot be `false`, so nothing ever flagged the interpolation.

**Fix:** `expected`/`actual` typed `unknown` and passed through a `ruleValue()`
that calls `String()` and maps empty to `—`. Both halves of the row now wrap.
The card header gained `flex-wrap` so a long gate result badge
(`defer:next_window@2026-09-05T08:00:00+05:30`, and `Badge` is
`whitespace-nowrap` by design) drops to its own line instead of pushing out.
The raw Razorpay error block and the message body got the same wrapping
treatment, since `description` is free text and a message body can carry a URL.

**Cost:** ~20 minutes.
**What it means:** the reported bug was cosmetic and the bug beside it was not.
Worth noting how it stayed invisible: `expected · actual` reads like a rule that
had nothing to compare rather than like a rendering failure — the fifth defect
on this project to disguise itself as a plausible empty state rather than an
error. Also a reminder that a hand-written interface over a `jsonb` column is an
assertion, not a check: this one was simply wrong, and being wrong is what
stopped the compiler from catching the consequence.

**Not fixed, and out of scope:** the drawer overflows its viewport at 390px.
That is pre-existing and page-wide — the Control Tower's KPI strip, outage
banners and queue tabs already overflow at that width with no drawer open. It is
a desktop operations console by design and making it responsive is a different
job from fixing a wrapping bug.

---

## 32. A two-second cooldown answered with a two-and-a-half-hour backoff

**When:** Milestone 11, chasing "why has `recovery.execute` completed 5 of 4,533
attempts in six and a half hours?"

**Symptom:** 3,590 attempts past their scheduled time, `executed_at` frozen at 5
since 02:32 UTC, and `messages` stuck at the same 5 rows — all of them written
before Gemini was wired, so none could ever be the composed row I was watching
for. The Inngest queue looked healthy: runs were being created continuously and
sat in QUEUED.

**First two theories, both wrong.** `recovery.execute` is the only function
carrying `concurrency: { limit: 5 }`, and exactly 5 attempts had executed. That
coincidence is almost perfect and it is meaningless. The second theory was queue
starvation — the dev server tops out around 34 runs/min and `triage.classify`,
`recovery.plan` and `experiment.assign` were all competing. Also wrong.

**Diagnosis:** the run trace showed `create-payment-link` FAILED across four
attempts at 06:19, 06:27, 06:52 and 08:48, each failing in about a second, the
run dying before it ever reached `compose` or `record-send`. The error:

```
RazorpayError: Too many requests
```

Probing the API directly is what made it obvious. A GET returned 200 in 534ms.
A POST to the same account returned:

```
HTTP 429 in 95ms   retry-after: 2
```

Razorpay rate-limits link creation on a short token bucket and **says how long
to wait**. Two seconds. Nothing in `razorpay.ts` read the header. It marked 429
retriable and handed it to Inngest, whose retry ladder is sized for
infrastructure outages: 8 minutes, then 25, then 2 hours, then the run is dead.
A two-second cooldown was escalated into a 150-minute one and then a permanent
failure, ~4,500 times over.

The comment above the function's `throttle` block describes exactly this failure
from an earlier 600-event batch, and the throttle was the fix. It was not
enough, and worse — the retries themselves are load. 3,590 past-due attempts x 4
tries is ~14,000 create calls against a bucket that wanted 2 seconds between
them. The mechanism that was supposed to protect the rail was feeding it.

**Fix:** two halves, both in `src/core/rails/razorpay.ts`.

1. `RazorpayError` now carries `retryAfterMs` parsed from the header, and
   `call()` waits it out **in-process** — bounded by a 20s budget, after which
   the durable retry is the right escalation, just not the first one. Jitter is
   load-bearing: without it every run 429'd in the same second wakes in the same
   second and collides again.
2. Writes pass through a shared pacer whose interval doubles on a 429 and decays
   on success, so the process converges on the real ceiling instead of guessing.
   Process-local, which is the honest scope for one dev server; a multi-instance
   deploy would need this in Redis beside the policy counters.

**What the fix did not do:** clear the block. By the time it landed, the account
had escalated from the short bucket to a coarser cooldown — a different envelope
(`"Request failed. Please try after sometime."`, `source: "business"`, and no
`Retry-After` header at all). Code cannot shorten that; only not hammering can.
The fix prevents the next occurrence, it does not undo this one.

**The honest lesson:** I read the 429 as "we are going too fast" and reached for
capacity controls, when the response body was already telling me the exact
remedy in a header I never read. And retry policy is not one setting — a token
bucket and a dead upstream both surface as "retriable" and want opposite
backoffs. Treating them the same turned a self-healing condition into a
self-inflicted outage.

**Cost:** ~50 minutes to diagnose, ~15 to fix, and a Razorpay test account in
cooldown for an unknown period on demo day.

## 33. Ten thousand events went missing twice — once to a lazy route, once to me

**When:** Milestone 11, growing the corpus so the Lab's two caveats would clear.

**Symptom:** three batches ingested cleanly — 18,358 at-risk rows — but only
6,934 arm assignments. The metrics inner-join `arm_assignments`, so 11,400
events were invisible to the only number this project is judged on. The batches
said `complete`. Nothing was in an error state. The corpus had simply stopped
growing, and the screen reporting on it had no way to say so.

**First cause: a route nobody had asked for yet.** `experiment.assign` runs on
Inngest, and Inngest reaches the app over HTTP. `next dev` compiles a route on
its first request, so `/api/inngest` did not exist until something asked for it
— and the only thing that would have asked was Inngest itself. Both processes
were up, both looked healthy, and no work moved. A `curl` against the route to
check it was alive is what started the drain; the diagnostic was the fix, which
is the kind of thing you only notice if you were watching the numbers before and
after.

**Second cause: me.** Chasing the wrong theory in #32, I restarted the Inngest
dev server to clear what I thought was wedged throttle state. Its queue is held
in memory. The restart dropped every event in flight and the drain stopped dead
— not slowed, stopped, because the events that would have driven it no longer
existed anywhere. Three hours of nothing, on top of a theory that was already
wrong.

**Why it could not just be re-ingested:** the events were in `payment_events`
already. Re-running the generator would have produced new ids, not reprocessed
these. And `reclassify.ts` deliberately writes only `classifications` —
re-queueing `event.ready_for_triage` is what it exists to avoid, because for an
already-planned event that mints a second recovery attempt.

**Fix:** [`scripts/requeue-triage.ts`](scripts/requeue-triage.ts) re-emits
`event.ready_for_triage` for events with no arm assignment, re-entering the real
pipeline at the top so classify → assign → plan all run with their ledger
receipts rather than being simulated by a script. The filter is the safety
argument: `recovery.plan` is triggered by `event.assigned`, so an event with no
assignment has never been planned and holds no attempt, and re-queueing it
cannot duplicate one. Classification is idempotent (`onConflictDoUpdate`), so
the few events classified but never assigned re-classify harmlessly.

**The near-miss inside the fix.** The first version of that query excluded
recovered events — `and e.recovered_at is null` — on the reasoning that a
payment which came back does not need recovering. That is true and completely
beside the point: the arm is the *grouping key for the incrementality result*,
not an instruction to act. Assigning only events that never recovered would have
handed the estimator a population selected on the outcome and driven every arm's
recovery rate toward zero, and the headline number would have been confidently,
silently wrong. Caught on the dry-run, because the count came back 8,584 instead
of 10,526 and the gap needed explaining. The query now takes every at-risk event
and the comment says why.

**What it means for the system:** a dev server's queue is not durable state, and
the corpus can shrink without anything reporting an error — the batch record
says `complete` because ingestion completed, which is a different claim from
"the pipeline processed it". The gap is now recoverable in one command instead
of a manual re-ingest. What is still missing is the check that would have caught
it on its own: at-risk events with no assignment is a number the Lab could show
beside its corpus count, and does not.

**Cost:** ~3 hours of stalled drain, self-inflicted; ~40 minutes to diagnose the
lazy-route half and write the recovery script.

## 34. The watcher went quiet, and quiet read as "still waiting"

**What broke:** the script left running to catch the Razorpay cooldown lifting
stopped measuring anything at 15:38 and nobody noticed for eight hours. Its
last five heartbeats said `probe error (continuing): fetch failed`, and then it
said nothing at all for six hours while its process sat alive and idle.

**Why:** two causes stacked. The Mac took maintenance sleeps at 15:39, 15:54,
16:10, 17:19, 17:34 and 17:50 — `pmset -g log` has all six — and each one cut
the network under an in-flight request. Undici keeps sockets alive between
calls, so the pool came back holding connections to a NAT binding that no
longer existed. Worse, the loop eventually wedged inside a `fetch` that
`AbortSignal.timeout` never rescued: the abort fires on a timer, but the
promise it was racing had already been handed a socket that would never settle
or error. The heartbeat lived *after* the probe in the same loop body, so a
hung probe took the heartbeat down with it.

**How I found it:** not from the watcher — from asking why a script that prints
every 30 minutes had printed nothing since 18:08. `ps -o lstart` said the
process had started at 18:05, three minutes before its last line, which meant
the log I was reading spanned two incarnations and the current one had emitted
exactly once. A plain `curl` POST from the shell returned a clean 429 in half a
second, proving the account was reachable and the probe was not.

**The fix:** three changes, all aimed at the silence rather than the network.
`connection: close` on every probe, so no socket is ever reused across a sleep
boundary. A `Promise.race` deadline *outside* `fetch`, so a wedged socket
cannot outlive its timeout even when the abort signal is ignored. And
heartbeats keyed to wall-clock rather than to loop iterations, plus a stall
alarm that fires when no probe has reached Razorpay for 45 minutes.

**What it means for the system:** the monitoring guidance I was working to says
a filter must match every terminal state because silence looks identical to
"still running". I wrote a watcher that obeyed that for the *job* it watched —
it had lines for cleared, fired, aborted, and failed-before-compose — and then
let the watcher's own liveness go unmonitored. A probe that cannot reach the
thing it is probing is not a quiet probe, it is a broken instrument, and it now
says so out loud. The same hole exists in any long-lived poller on a laptop
that sleeps, which in this project is all of them.

**Cost:** eight hours of wall-clock in which the cooldown might have lifted and
nothing would have fired. Unrecoverable — but see #32, the cooldown had not
lifted anyway, so the loss was of information rather than of a window.

## 35. #23's fix degraded WhatsApp to "a channel that actually delivers". It does not.

**What broke:** #23 caught the WhatsApp rail creating a payment link and telling
nobody, and fixed it by degrading WhatsApp to SMS — "the same phone number, a
channel that actually delivers". That last clause is false, and the audit that
found it was asking a different question: does the composed message reach anyone
at all?

**The code path, end to end.** `createPaymentLink` is called with
`notify: { sms: channel === 'sms', email: channel === 'email' }` and **no
`customer` object** — the call passes `amountPaise`, `currency`, `description`,
`notify`, `referenceId`, `expireBy`, `notes`, and nothing else. Razorpay's
notification needs a customer contact or email to send to. Without one it has
no address, so `notify: { sms: true }` instructs it to notify nobody.

This is not inference. Every link the pipeline has created is still on the
account and says so:

```
id=plink_TYBwRVZl5NDJlc  customer=[]  notify={"email":false,"sms":true,"whatsapp":false}
id=plink_TYBwR03PoffpEu  customer=[]  notify={"email":true,"sms":false,"whatsapp":false}
```

`customer` is empty on all of them. The flag is set; the recipient is not.

**And the composed copy is never transmitted on any rail.** `composed.body`
appears exactly once in the codebase — `recovery-execute.ts:309`, the
`db.insert(messages)` call. It goes into a column and nowhere else. There is no
SMS or email client in the repo; `src/core/rails/` holds `razorpay.ts` and
`whatsapp.ts` and nothing more. Even the WhatsApp branch, the one rail that
sends anything itself, calls `sendTemplate` with a Meta pre-approved template
name and the variables `[MERCHANT_NAME, ₹amount]` — not the Gemini text. So
there is no configuration of this system in which a customer reads what the
model wrote.

**What gets recorded anyway.** `messages` is inserted with `sent_at` set, the
event moves to `action_sent`, and a ledger receipt is appended. On the five
attempts that have executed:

```
messages: total=5  marked_sent=5  with_provider_id=0
audit_ledger: action_sent receipts = 5
```

`provider_message_id` is the only field that tells the truth — it is non-null
only for a real WhatsApp send, and WhatsApp is unconfigured
(`WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` are both unset), so
`effectiveChannel` degrades every `whatsapp_nudge` to SMS and that branch never
runs. Five sends recorded, five customers uncontacted, zero provider ids.

**What it means for the system:** #23 correctly identified that an uncontacted
customer counted as contacted converts a treated event into an untreated one and
biases incrementality toward zero. That diagnosis was right and its scope was
too narrow — it treated the defect as specific to WhatsApp when it belongs to
the notification design shared by every rail. The incrementality result is not
invalidated, because the recovery outcomes in the corpus are synthetic and were
never conditioned on a real send; but the claim "we sent the customer this
message" is not supported by anything in the database, and the payment links —
which are real, live Razorpay objects with working `short_url`s — are the only
part of the send that exists.

**Fix:** not attempted tonight. Attaching a `customer` object means holding a
raw phone or email, and the system deliberately stores only a sha256 and a
display mask; that is a design decision, not an oversight, and reversing it
hours before a demo to make a send real would be the wrong trade. What changes
now is what gets claimed: the links are real, the composition is real Gemini
output, and delivery is not wired. `provider_message_id` already distinguishes
the two and should be what the Ledger screen reads.

## 36. A true zero read as a broken screen

**What broke:** the Outage Radar led with "Agreement with Razorpay — 0%" in
26px type, above a table where every row's Downtime API badge said
`disagrees`. Nothing was wrong. Every outage window in this deployment is
synthetic and injected by the generator, so Razorpay's live Payment Downtime
feed has nothing matching them and the agreement rate is zero by construction.
A pre-demo audit read the screen for two seconds and concluded the detector
was broken, which is the exact opposite of what that panel measures.

**Why it happened:** the tile was designed while the number was interesting.
An agreement rate is a good headline when there is a real feed to agree with;
in a synthetic deployment it is a constant, and a constant does not deserve
the largest type on the screen. The denominator was already stated underneath
— honesty was never the problem. Prominence was.

**Fix:** the strip now leads with what the detector actually did — windows
detected, and the rupees parked inside them. The agreement rate moved to the
footnote line under the window count, with the reason it is zero stated in the
same breath: *"0% corroborated — synthetic windows, nothing for the live feed
to match."* Same number, same denominator, no longer the first thing an eye
lands on. The per-row `disagrees` badges stay as they are: at row level, next
to a specific cohort and a specific window, "the feed did not corroborate this
one" is precisely the right claim.

**The same bug, one tile over.** `median_detection_lead` renders `——` when no
window was seen by both systems, which at 26px in muted grey is visually
indistinguishable from the skeleton loader two seconds earlier. It now reads
"no overlap", with "no window was seen by both, so there is nothing to time"
underneath. An absent value and a loading value must not look alike on a
screen whose whole job is to be read at a glance.

**The general lesson:** a correct number displayed at the wrong prominence is
a reporting bug. On an operations console the visual hierarchy is a claim
about what matters, and a zero given hero treatment claims something is wrong.

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

**Triage thresholds are tuned, and the binding constraint is volume.** This
entry used to say they were untuned guesses; they are not, as of #22. `n ≥ 16`,
`3σ`, `0.30` absolute floor, tuned by `npm run tune:triage` against four volume
scenarios and scored at the *worst* of the four rather than the average. The
sigma multiplier is inert at this scale — the absolute floor binds first — which
is stated here rather than left to be discovered. Both precision and recall clear
0.8 on every scenario; the tightest is the brief-outage case at P 84.7 / R 81.3.

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
