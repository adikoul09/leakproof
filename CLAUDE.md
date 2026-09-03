# LEAKPROOF — Razorpay Buildathon Track 03

Revenue recovery control tower. Deadline 5 Sept. Solo builder, ~28 hrs available.

## Read these first, in this order
1. `leakproof-claude-code-kickoff.md` — condensed brief: locked decisions, account status, env vars, build order, an important correction to the outage demo scenario. Read this every session, it's short.
2. `Requirements.md` — API keys / env var reference (values only, don't restate them in chat or commits).
3. `LEAKPROOF_BLUEPRINT.md` — the full spec (UI wireframes, data model, all 25 API endpoints, hour-by-hour timeline). Pull specific sections from this as needed rather than reading it end to end every time.

## Non-negotiables — do not re-ask or relitigate
- Stack: Next.js 15 (App Router) + TypeScript strict, Drizzle ORM, Neon Postgres, Inngest, Upstash Redis (or Postgres counters as fallback), Tailwind + shadcn/ui, Recharts, Monaco, SSE (not WebSockets), Vercel.
- Control arm 18% / Naive 20% / LEAKPROOF 62%. Batch size 3,000 synthetic events.
- Rail routing: static table for v1, not a bandit. Document the bandit as a deliberate cut.
- Second surface: Subscriptions (dunning), not invoices. Hinglish voice: not building it.
- Primary LLM: Gemini (`gemini-2.5-flash`), behind one `composeMessage()` interface.
- Outage demo scenario: **card issuer outage**, not netbanking — the Payment Downtime API only covers card/ach. See the kickoff brief for the full reasoning.
- Dark theme only. Public demo URL for judges, not repo-only.

## Build order (ship in this sequence, no exceptions on the first 8)
1. Webhook ingestion + failure taxonomy classification
2. Policy engine (caps, contact window, stop_on, circuit breaker)
3. One recovery rail end to end (Razorpay Payment Link)
4. Control group + incrementality maths — **this is what the project is judged on**
5. Hash-chained audit ledger
6. Synthetic data generator (documented, first-class repo citizen)
7. Control Tower dashboard
8. Replay / what-if engine

Cut in this order if time runs short: bandit → subscriptions/invoices sub-surfaces → Hinglish voice (cut first).

## UI direction
Dense operations dashboard — think payments war-room console, not a marketing site. Component-level polish can draw on shadcn/ 21st.dev conventions (fits the chosen stack), but keep layouts dense and functional per the blueprint's Section 5 design system (dark ops console tokens, fixed arm colors, status badges). Avoid landing-page patterns — big hero sections, gradient text, scroll-triggered animation — those work against the "real internal tool" read the judges are looking for.

## Working conventions
- Keep `FAILURES.md` updated live as things break — it's a scored criterion, not just a nice-to-have.
- Money is always paise, integer. Timestamps ISO-8601 with offset.
- Never commit real secrets — `.env.local` only, `.env.example` gets placeholders. Run `gitleaks` before any push to the public repo.
- One test at every milestone: if you stopped right now, could you show a panel a number, a control group, and a receipt for it?
