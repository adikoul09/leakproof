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
