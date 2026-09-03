/**
 * Policy schema — the YAML an operator edits in Policy Studio.
 *
 * Everything the gate will ever need is validated *here*, at authoring time,
 * so that evaluation cannot fail on a malformed policy. A gate that can throw
 * is not a gate. That includes the circuit-breaker trigger expression, which
 * is parsed into a typed comparison at publish time rather than interpreted
 * live.
 */
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Stop conditions that end recovery for an event, no matter what else says. */
export const STOP_CONDITIONS = [
  'payment_success',
  'customer_opt_out',
  'complaint_keyword_detected',
  'refund_issued',
] as const;
export type StopCondition = (typeof STOP_CONDITIONS)[number];

/** Metrics the circuit-breaker trigger may reference. */
export const BREAKER_METRICS = ['decline_rate_5min', 'decline_rate_15min'] as const;
export type BreakerMetric = (typeof BREAKER_METRICS)[number];

export const BREAKER_ACTIONS = ['halt_all_retries', 'halt_new_contacts'] as const;

/**
 * `"decline_rate_5min > 40%"` → `{metric, op, threshold: 0.4}`.
 *
 * Deliberately not an expression language. An operator-editable policy that
 * can express arbitrary code is a liability, and the three shapes below cover
 * everything the blueprint asks for.
 */
const TRIGGER_RE = /^\s*(\w+)\s*(>|>=|<|<=)\s*([0-9]*\.?[0-9]+)\s*(%?)\s*$/;

export interface BreakerTrigger {
  metric: BreakerMetric;
  op: '>' | '>=' | '<' | '<=';
  /** Always a proportion in [0,1], whatever unit the author wrote. */
  threshold: number;
  /** The author's original text, echoed back in the UI and the trace. */
  source: string;
}

export function parseBreakerTrigger(source: string): BreakerTrigger {
  const m = TRIGGER_RE.exec(source);
  if (!m) {
    throw new Error(
      `must look like "decline_rate_5min > 40%" (metric, comparison, number); got "${source}"`,
    );
  }
  const [, metric, op, num, pct] = m;
  if (!(BREAKER_METRICS as readonly string[]).includes(metric)) {
    throw new Error(`unknown metric "${metric}"; supported: ${BREAKER_METRICS.join(', ')}`);
  }
  const raw = Number(num);
  const threshold = pct === '%' ? raw / 100 : raw;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`threshold must resolve to a proportion between 0 and 1; got ${threshold}`);
  }
  return { metric: metric as BreakerMetric, op: op as BreakerTrigger['op'], threshold, source };
}

export const policySchema = z.object({
  policy_version: z.union([z.string(), z.number()]).transform((v) => String(v)),

  contact_window: z.object({
    start: z.string().regex(HHMM, 'must be HH:MM, 24-hour'),
    end: z.string().regex(HHMM, 'must be HH:MM, 24-hour'),
    tz: z.string().min(1),
  }),

  caps: z.object({
    max_attempts_per_payment: z.number().int().min(1).max(10),
    max_contacts_per_customer_per_week: z.number().int().min(0).max(20),
    max_discount_offered_pct: z.number().min(0).max(100),
  }),

  stop_on: z.array(z.enum(STOP_CONDITIONS)).min(1),

  circuit_breaker: z.object({
    trigger: z.string().min(1),
    action: z.enum(BREAKER_ACTIONS),
  }),

  /**
   * Optional. Defaults true: a bank holiday means settlement cannot clear, so
   * chasing the payment that day is noise the customer did not earn.
   */
  respect_bank_holidays: z.boolean().default(true),
});

export type PolicyDoc = z.infer<typeof policySchema>;

/** A validated policy plus the pre-parsed pieces the gate needs. */
export interface Policy extends PolicyDoc {
  breaker: BreakerTrigger;
  /** Contact window as minutes-from-midnight in its own timezone. */
  windowStartMin: number;
  windowEndMin: number;
}

export interface PolicyIssue {
  path: string;
  message: string;
}

export type PolicyParseResult =
  | { ok: true; policy: Policy }
  | { ok: false; issues: PolicyIssue[] };

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Parse and fully validate a policy YAML source. Never throws. */
export function parsePolicy(yamlSource: string): PolicyParseResult {
  let doc: unknown;
  try {
    doc = parseYaml(yamlSource);
  } catch (err) {
    return {
      ok: false,
      issues: [{ path: '', message: `YAML did not parse: ${(err as Error).message}` }],
    };
  }

  const parsed = policySchema.safeParse(doc);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    };
  }

  let breaker: BreakerTrigger;
  try {
    breaker = parseBreakerTrigger(parsed.data.circuit_breaker.trigger);
  } catch (err) {
    return {
      ok: false,
      issues: [{ path: 'circuit_breaker.trigger', message: (err as Error).message }],
    };
  }

  const windowStartMin = toMinutes(parsed.data.contact_window.start);
  const windowEndMin = toMinutes(parsed.data.contact_window.end);
  if (windowEndMin <= windowStartMin) {
    return {
      ok: false,
      issues: [
        {
          path: 'contact_window.end',
          message: `must be later than contact_window.start (${parsed.data.contact_window.start})`,
        },
      ],
    };
  }

  return { ok: true, policy: { ...parsed.data, breaker, windowStartMin, windowEndMin } };
}
