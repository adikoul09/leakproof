# How the synthetic data was made

Every number LEAKPROOF reports about itself was computed over a corpus this
generator produced. Publishing how that corpus was constructed is what makes
the reported lift **auditable rather than assertable** — you can regenerate it
from the seed, disagree with a modelling choice, change it, and see what the
number does.

Nothing here is real customer data. Every customer, payment, subscription and
failure in the system is synthetic, and every screen says so.

---

## Reproducing a batch

A batch is a pure function of its spec, and the spec is stored on the batch row
with the seed in it:

```bash
npm run simulate -- --preset demo          # 3,000 at-risk events, 45-min HDFC card outage
npm run simulate -- --preset null_test     # same, with no effect planted at all
npm run simulate -- --preset panel         # small and fast, for a live demo
npm run simulate -- --preset demo --dry-run   # describe it, write nothing
```

or through the API:

```bash
curl -X POST $APP/api/simulator/generate \
  -H "authorization: Bearer $OPERATOR_ACCESS_KEY" \
  -d '{"preset":"demo"}'
# 202 { "batch_id": "...", "spec": {...}, "ground_truth": {...} }

curl $APP/api/simulator/batches/$BATCH_ID    # what was planted vs what was measured
```

The same seed produces byte-identical events on any machine, forever. That is
asserted in `src/core/simulator/generate.test.ts`, not hoped for.

---

## What is generated

`count` is the number of **at-risk (failed) events** — the rows that land in
`payment_events`. Successful payments are generated on top of that, because the
cohort decline rate is a *ratio* and a corpus of nothing but failures makes
every cohort read 100% declined, which makes the systemic detector meaningless.
A 3,000-failure batch therefore emits roughly 30,000 events.

| Piece | Distribution | Why |
|---|---|---|
| Ticket size | Log-normal per method (UPI median ≈ ₹420, card ≈ ₹1,850, netbanking ≈ ₹4,200) | The tail is the hard part. Uniform amounts would make the rupee confidence interval far tighter than it deserves to be, by engineering away the variance that actually dominates it. |
| Arrival time | Diurnal curve × payday multiplier | The overnight trough is what produces cohorts below `n ≥ 8`. A detector never shown a quiet hour will call an outage off three transactions. |
| Method | UPI 62%, card 22%, netbanking 11%, wallet 5% | UPI dominates by volume and carries the smallest ticket, so "recover the most payments" and "recover the most rupees" are genuinely different objectives. |
| Issuer | Long-tailed per method | Equal-volume issuers would mean small-sample noise never appears and the `n ≥ 8` guard would look like dead code. |
| Failure reason | Weighted mix per method, drawn from Razorpay's documented error taxonomy | See below. |
| Payday cycle | Volume up around the 1st and the 28th; `insufficient_funds` share up in the pre-payday lean | People have money on the 2nd and do not on the 25th. |

All of it lives in one file — [`src/core/simulator/profile.ts`](../src/core/simulator/profile.ts).
Every constant is a modelling choice that changes the headline result, so they
are collected where they can be read and argued with rather than scattered
through the generator.

**🔸 These are plausible figures for an Indian D2C / subscription merchant, not
measurements of Razorpay's real traffic.** Nothing here has been calibrated
against a production dataset. The generator's job is to be honestly *shaped*,
not to be true.

### Landing exactly on the target count

The failure draw is a Bernoulli per attempt, so the realised count lands within
a percent or two of the target and never on it. The difference is flipped on
attempts drawn uniformly from **outside** the outage window: uniform selection
introduces no cohort bias, the correction moves the overall decline rate by well
under half a percentage point, and excluding the outage window means the planted
signal is never touched by the bookkeeping. `summary.rebalancedBy` reports how
many were moved, so it is visible rather than hidden.

---

## The injected outage

The demo scenario is a **card issuer outage** (HDFC), not netbanking — Razorpay's
Payment Downtime API is what the classification is cross-checked against, and
the reasoning for card is in the project brief.

The failures arriving during a degradation are deliberately **not** uniformly
labelled `issuer_down`. That would make detection trivial and the injected
outage worthless as a test. A real outage is a mix:

| Share | Reason | |
|---|---|---|
| 30% | `gateway_technical_error` | unhelpful, and the most common thing you actually see |
| 26% | `issuer_unavailable` | the clearly-labelled case |
| 22% | `payment_failed` | Razorpay's shrug |
| 14% | `server_error` | |
| 8% | `insufficient_funds` | **ordinary customer failures that happen to land in the window** |

That last row is what stops precision from being free. Ground truth is per event
and comes from the payload the generator planted, **not from membership of the
window**: an insufficient-funds decline inside the outage is still an
idiosyncratic failure, and counting it as systemic would hand the detector
precision it did not earn.

---

## Organic recovery, and the control arm

Some failures recover on their own — the customer retries, their bank comes
back, the card gets topped up. The generator emits these as a **success carrying
the failed payment's `order_id` and a new payment id**, which is exactly what
Razorpay does on a retry.

This is load-bearing. The control arm is never contacted, so an organic match is
the *only* way it ever records a recovery. If organic recovery were not detected
the control rate would read zero and every incrementality number would be
inflated to the point of fraud.

**Censoring is modelled, not papered over.** Time-to-recovery is heavy-tailed
(median ≈ 38 minutes, with a tail into the next day), and a recovery that would
land after the window closes is simply not emitted — it has not happened yet.
Real corpora are censored at their right edge in exactly this way. The effect is
substantial: on a 4-hour window, over a third of recoveries are censored. All
arms are censored equally, so the comparison stays valid, but the *realised*
rates are below the nominal ones, which is why ground truth is measured off the
emitted corpus rather than copied from the spec.

---

## The planted treatment effect — read this before believing any lift

A synthetic customer cannot pay a real Razorpay payment link. On synthetic data
the treated arms have no mechanism by which to actually recover more money, so
the generator has two modes.

**A/A null test** (`treatment_response: null`) plants **no effect**: all three
arms recover at the same rate and the true lift is exactly zero. This is the
more valuable mode. An estimator that reports a lift on data containing none is
broken, and no A/B result from it can be trusted afterwards.

**Planted effect** (`treatment_response: {...}`) raises the recovery rate for the
naive and LEAKPROOF arms by a stated number of percentage points. This validates
that the estimator recovers an effect known to be present. **It is not evidence
that LEAKPROOF recovers revenue on real traffic**, and the README says so in the
same words.

### The ground truth is counterfactual, not a sample statistic

Recovery is decided by a **single uniform draw** `u` per event:

```
recovers            when  u < organic + uplift
would have anyway   when  u < organic
caused by treatment when  organic <= u < organic + uplift
```

So the generator knows, per event, whether the recovery was *caused* by the
treatment, and `trueIncrementalPaise` is the summed value of exactly those
events. Two independent draws would have made the counterfactual unknowable.

This matters more than it sounds. The estimator computes incremental revenue as
`n_treated × (mean recovered value treated − control)`. Scoring that against a
ground truth defined the same way would be the estimator marking its own
homework. Against the counterfactual it is a real test — and it fails
informatively: on one 24-hour seed the true incremental was ₹8,97,066 while the
sample difference-in-means came out at ₹2,37,201, a 3.8× gap driven entirely by
which arm happened to catch the largest tickets. **The rate lift was accurate to
within a percentage point over the same corpus.** Read the interval, not the
point, and prefer the rate.

---

## Adversarial cases

`adversarial_pct` of failures get one hostile trait each:

| Kind | What it does | What it is testing |
|---|---|---|
| `unlabelled_error` | empty or unmapped error payloads | the taxonomy must answer `unknown` rather than guess |
| `duplicate_delivery` | the same event emitted twice, byte-identical | ingestion must not create a second at-risk row or a second cohort observation |
| `out_of_order_recovery` | the success arrives *before* the failure it resolves | matching strictly forward in time silently drops the recovery — and it is the control arm's rupees that go missing |
| `opted_out_customer` | customer already opted out | the policy gate must block before anything is sent |
| `late_webhook` | delivered 45–240 minutes after the failure occurred | the pipeline must place the event by `failed_at`, not by arrival, or backdated volume poisons the cohort window |

`out_of_order_recovery` is only assigned to events that actually recover — there
is nothing to reorder otherwise. An earlier version marked it regardless and
reported 73 out-of-order deliveries when 8 had been emitted.

---

## What the generator is used for

**1. Tuning the systemic detector.** `npm run tune:triage` replays generated
corpora through the real `classify()` and the real cohort store, sweeps
thresholds, and scores against the per-event ground truth. It exits non-zero if
the deployed configuration misses the blueprint's bar of 0.8 precision and 0.8
recall. This is how `absoluteFloor` moved from 0.25 to 0.35 — the details and
two uncomfortable findings are in [`FAILURES.md`](../FAILURES.md).

**2. Validating the incrementality estimator.**
`GET /api/simulator/batches/:id` puts the planted counterfactual next to the
measured interval and says whether the interval covered the truth.

**3. Filling the tower for a demo.** The presets in
[`src/core/simulator/presets.ts`](../src/core/simulator/presets.ts) are the same
specs the UI buttons press, so a demo cannot quietly run something other than
what is documented.

### Running one for a panel

- **Generate before they are watching.** A 3,000-failure batch is ~30,000 events
  through the real pipeline; ingestion plus triage takes several minutes. Use the
  `panel` preset live and have a `demo` batch already sitting in the table.
- **Pick a working day.** The contact window is 08:00–19:00 IST and bank holidays
  defer, so a batch generated on a holiday will show a queue full of correctly
  deferred events and nothing being sent — accurate, and a confusing thing to
  demo.

---

## Known limitations

- **An injected outage is, by construction, detectable.** Real degradation is
  messier: partial, drifting, overlapping with other issues. Precision and
  recall on this corpus are an upper bound. Real-traffic validation is untested.
- **The profile is uncalibrated.** Plausible, not measured. If the real method
  mix or decline rates differ materially, the tuned thresholds move with them.
- **No real declines.** `POST /api/simulator/push-to-razorpay` creates genuine
  test-mode *orders*, so ids resolve in the Razorpay dashboard, but a real failed
  payment cannot be produced server-side — payments are created through checkout.
  The failure payloads are modelled on the documented error taxonomy. The part
  that is real end to end is the recovery rail: payment links are created,
  delivered and paid for real.
- **Attribution reads 0% on synthetic batches.** A synthetic customer cannot pay
  a real link, so every recovery arrives as organic. The incrementality maths is
  unaffected — it measures rupees, not attribution — but the attributed/organic
  split on a synthetic batch means nothing.
