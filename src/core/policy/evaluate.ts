/**
 * The policy gate — blueprint 6.5.
 *
 * Pure, deterministic, no I/O. Every fact it needs arrives in the context;
 * it never queries a database, never calls the network, never reads the clock.
 * Two reasons, both load-bearing:
 *
 *   1. **A policy gate that can time out is not a gate.** If this function
 *      could make a network call, a slow holiday API would mean the difference
 *      between contacting a customer and not contacting them.
 *   2. The replay engine drives this exact function over a historical corpus.
 *      Any hidden input would make replay a different system wearing the same
 *      name, and the what-if numbers would be fiction.
 *
 * Rules run in a fixed order and short-circuit on the first *block*, so the
 * trace reads top-to-bottom as an explanation. Defers do not short-circuit —
 * a later block still wins over an earlier defer, because "we would have
 * waited, but we were never allowed" is the truthful answer.
 */
import type { Policy, StopCondition } from './schema';
import { addDays, toOffsetIso, zonedParts, zonedTimeToUtc } from './tz';

export interface PolicyContext {
  /** Evaluation instant. Passed in, never read from the clock. */
  now: Date;
  /** Circuit breaker state for this event's cohort, decided elsewhere. */
  breakerOpen: boolean;
  breakerReason?: string;
  customerOptedOut: boolean;
  /** Stop conditions already observed for this event. */
  firedStopConditions: StopCondition[];
  /** Recovery attempts already made against this payment. */
  attemptsSoFar: number;
  /** Contacts to this customer in the trailing 7 days. */
  contactsThisWeek: number;
  /** Bank-holiday date keys ('YYYY-MM-DD', policy timezone). Pre-warmed. */
  bankHolidays: ReadonlySet<string>;
  /** Discount the proposed action would offer, as a percentage. */
  proposedDiscountPct?: number;
}

export interface RuleTrace {
  rule: string;
  expected: string | number | boolean;
  actual: string | number | boolean;
  pass: boolean;
}

export type GateOutcome = 'allow' | 'block' | 'defer';

export interface PolicyDecision {
  result: GateOutcome;
  /** The compact form stored on policy_evaluations.gate_result. */
  gateResult: string;
  reasons: string[];
  rulesTrace: RuleTrace[];
  /** ISO-8601 with offset, present when result is 'defer'. */
  deferUntil?: string;
}

/** How many days forward we will look for an open window before giving up. */
const MAX_DEFER_DAYS = 14;

/**
 * The next instant inside the contact window that is not a bank holiday.
 * Returns null if no such moment exists within MAX_DEFER_DAYS — which means
 * something is wrong with the policy, and blocking is safer than deferring
 * into a date that never arrives.
 */
function nextOpenWindow(policy: Policy, from: Date, holidays: ReadonlySet<string>): Date | null {
  const tz = policy.contact_window.tz;
  const here = zonedParts(from, tz);
  const respectHolidays = policy.respect_bank_holidays;

  for (let i = 0; i <= MAX_DEFER_DAYS; i += 1) {
    const dateKey = addDays(here.dateKey, i);
    if (respectHolidays && holidays.has(dateKey)) continue;

    const [y, m, d] = dateKey.split('-').map(Number);
    // Today, already inside the window: now. Today, before it opens: at open.
    // Any later day: at open.
    const startsAt = i === 0 ? Math.max(policy.windowStartMin, here.minutesOfDay) : policy.windowStartMin;
    if (startsAt >= policy.windowEndMin) continue; // today's window has closed
    return zonedTimeToUtc(y, m, d, startsAt, tz);
  }
  return null;
}

export function evaluatePolicy(policy: Policy, ctx: PolicyContext): PolicyDecision {
  const trace: RuleTrace[] = [];
  const tz = policy.contact_window.tz;
  const local = zonedParts(ctx.now, tz);

  const blocked = (rule: string, code: string, reason: string): PolicyDecision => ({
    result: 'block',
    gateResult: `block:${code}`,
    reasons: [reason],
    rulesTrace: trace,
  });

  // ── 1. Circuit breaker ────────────────────────────────────────────
  trace.push({
    rule: 'circuit_breaker',
    expected: 'closed',
    actual: ctx.breakerOpen ? 'open' : 'closed',
    pass: !ctx.breakerOpen,
  });
  if (ctx.breakerOpen) {
    return blocked(
      'circuit_breaker',
      'breaker_open',
      ctx.breakerReason
        ? `circuit breaker is open: ${ctx.breakerReason}`
        : 'circuit breaker is open',
    );
  }

  // ── 2. Customer opt-out ───────────────────────────────────────────
  trace.push({
    rule: 'customer_opt_out',
    expected: false,
    actual: ctx.customerOptedOut,
    pass: !ctx.customerOptedOut,
  });
  if (ctx.customerOptedOut) {
    return blocked('customer_opt_out', 'opted_out', 'customer has opted out of contact');
  }

  // ── 3. Stop conditions ────────────────────────────────────────────
  const fired = ctx.firedStopConditions.filter((c) => policy.stop_on.includes(c));
  trace.push({
    rule: 'stop_on',
    expected: `none of ${policy.stop_on.join(',')}`,
    actual: fired.length ? fired.join(',') : 'none',
    pass: fired.length === 0,
  });
  if (fired.length > 0) {
    return blocked('stop_on', 'stop_on_fired', `stop condition fired: ${fired.join(', ')}`);
  }

  // ── 4. Attempts cap ───────────────────────────────────────────────
  const attemptsOk = ctx.attemptsSoFar < policy.caps.max_attempts_per_payment;
  trace.push({
    rule: 'max_attempts_per_payment',
    expected: policy.caps.max_attempts_per_payment,
    actual: ctx.attemptsSoFar,
    pass: attemptsOk,
  });
  if (!attemptsOk) {
    return blocked(
      'max_attempts_per_payment',
      'cap_exceeded',
      `already made ${ctx.attemptsSoFar} of ${policy.caps.max_attempts_per_payment} permitted attempts`,
    );
  }

  // ── 5. Weekly contact cap ─────────────────────────────────────────
  const contactsOk = ctx.contactsThisWeek < policy.caps.max_contacts_per_customer_per_week;
  trace.push({
    rule: 'max_contacts_per_customer_per_week',
    expected: policy.caps.max_contacts_per_customer_per_week,
    actual: ctx.contactsThisWeek,
    pass: contactsOk,
  });
  if (!contactsOk) {
    return blocked(
      'max_contacts_per_customer_per_week',
      'cap_exceeded',
      `customer already contacted ${ctx.contactsThisWeek} times in the trailing week`,
    );
  }

  // ── 6. Bank holiday — defers, does not block ──────────────────────
  // Settlement cannot clear today, but it can tomorrow. Blocking outright
  // would throw away a recoverable payment over a calendar accident.
  const isHoliday = policy.respect_bank_holidays && ctx.bankHolidays.has(local.dateKey);
  trace.push({
    rule: 'bank_holiday',
    expected: false,
    actual: isHoliday,
    pass: !isHoliday,
  });

  // ── 7. Contact window — defers, does not block ────────────────────
  const insideWindow =
    local.minutesOfDay >= policy.windowStartMin && local.minutesOfDay < policy.windowEndMin;
  const hhmm = `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`;
  trace.push({
    rule: 'contact_window',
    expected: `${policy.contact_window.start}-${policy.contact_window.end} ${tz}`,
    actual: `${hhmm} ${tz}`,
    pass: insideWindow,
  });

  // ── 8. Discount cap ───────────────────────────────────────────────
  const discount = ctx.proposedDiscountPct ?? 0;
  const discountOk = discount <= policy.caps.max_discount_offered_pct;
  trace.push({
    rule: 'max_discount_offered_pct',
    expected: policy.caps.max_discount_offered_pct,
    actual: discount,
    pass: discountOk,
  });
  if (!discountOk) {
    return blocked(
      'max_discount_offered_pct',
      'discount_cap_exceeded',
      `proposed discount ${discount}% exceeds the ${policy.caps.max_discount_offered_pct}% authority`,
    );
  }

  // Blocks are settled. What remains is now-or-later.
  if (isHoliday || !insideWindow) {
    const next = nextOpenWindow(policy, ctx.now, ctx.bankHolidays);
    if (!next) {
      // No reachable window inside MAX_DEFER_DAYS: deferring into a date that
      // never arrives would silently strand the event, so block instead.
      return blocked(
        'contact_window',
        'outside_window',
        `no open contact window within ${MAX_DEFER_DAYS} days`,
      );
    }
    const deferUntil = toOffsetIso(next, tz);
    const reasons = [
      ...(isHoliday ? [`${local.dateKey} is a bank holiday`] : []),
      ...(!insideWindow ? [`${hhmm} is outside ${policy.contact_window.start}-${policy.contact_window.end}`] : []),
    ];
    return {
      result: 'defer',
      gateResult: `defer:next_window@${deferUntil}`,
      reasons,
      rulesTrace: trace,
      deferUntil,
    };
  }

  return {
    result: 'allow',
    gateResult: 'allow:contact_window,under_caps',
    reasons: ['inside contact window', 'under all caps'],
    rulesTrace: trace,
  };
}
