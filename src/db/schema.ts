/**
 * LEAKPROOF data model — blueprint Section 6.2.
 *
 * Conventions that hold everywhere:
 *   - money is paise, integer, never float
 *   - timestamps are timestamptz; the app serialises ISO-8601 with offset
 *   - table/column names stay snake_case so the raw SQL in the blueprint,
 *     the ledger export and any psql spelunking all line up
 */
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ─── Enums ──────────────────────────────────────────────────────────
export const surfaceT = pgEnum('surface_t', ['payment', 'subscription', 'invoice']);

export const eventStateT = pgEnum('event_state_t', [
  'at_risk',
  'classifying',
  'planned',
  'waiting_out_outage',
  'deferred',
  'blocked_by_policy',
  'action_sent',
  'recovered',
  'lost',
  'stopped',
]);

export const failureKindT = pgEnum('failure_kind_t', ['systemic', 'idiosyncratic', 'unknown']);

export const armT = pgEnum('arm_t', ['control', 'naive', 'leakproof']);

// ─── Customers ──────────────────────────────────────────────────────
export const customers = pgTable('customers', {
  id: text('id').primaryKey(), // cust_xxx
  phoneHash: text('phone_hash').notNull(), // sha256, never raw
  phoneMasked: text('phone_masked').notNull(), // "+91••4821" for display
  emailHash: text('email_hash'),
  emailMasked: text('email_masked'),
  optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
  optOutReason: text('opt_out_reason'), // 'stop_reply'|'complaint'|'manual'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Raw webhook receipts (idempotency + replay protection) ─────────
export const webhookReceipts = pgTable('webhook_receipts', {
  eventId: text('event_id').primaryKey(), // x-razorpay-event-id
  eventType: text('event_type').notNull(),
  signature: text('signature').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb('payload').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});

// ─── Payment events (the at-risk unit) ──────────────────────────────
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: text('id').primaryKey(), // pay_xxx / sub_xxx / inv_xxx
    surface: surfaceT('surface').notNull(),
    customerId: text('customer_id').references(() => customers.id),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('INR'),
    method: text('method'), // card|upi|netbanking|wallet|emandate
    issuer: text('issuer'), // HDFC|ICICI|SBI...
    cardNetwork: text('card_network'),
    amountBand: text('amount_band'), // '<500','500-1k','1k-5k','5k-25k','25k+'
    timeBucket: smallint('time_bucket'), // hour of day IST 0-23
    // Razorpay structured error taxonomy, stored raw
    errCode: text('err_code'),
    errDescription: text('err_description'),
    errSource: text('err_source'),
    errStep: text('err_step'),
    errReason: text('err_reason'),
    state: eventStateT('state').notNull().default('at_risk'),
    isSynthetic: boolean('is_synthetic').notNull().default(true),
    failedAt: timestamp('failed_at', { withTimezone: true }).notNull(),
    recoveredAt: timestamp('recovered_at', { withTimezone: true }),
    recoveredPaise: bigint('recovered_paise', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payment_events_state_failed_at_idx').on(t.state, t.failedAt.desc()),
    index('payment_events_cohort_idx').on(t.issuer, t.method, t.failedAt.desc()),
  ],
);

// ─── Classification ─────────────────────────────────────────────────
export const classifications = pgTable('classifications', {
  eventId: text('event_id')
    .primaryKey()
    .references(() => paymentEvents.id),
  kind: failureKindT('kind').notNull(),
  // issuer_degraded|network_degraded|gateway_error|insufficient_funds|
  // auth_failure|expired_card|mandate_invalid|limit_exceeded|risk_blocked|
  // customer_abandoned|invoice_overdue|unknown
  failureClass: text('failure_class').notNull(),
  confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),
  cohortKey: text('cohort_key').notNull(), // 'HDFC|netbanking|1k-5k|14'
  cohortDeclineRate: numeric('cohort_decline_rate', { precision: 5, scale: 4 }),
  cohortN: integer('cohort_n'),
  // NULL = no signal. Recorded, never an input — see blueprint 6.5.
  downtimeApiAgrees: boolean('downtime_api_agrees'),
  outageWindowId: uuid('outage_window_id'),
  classifiedAt: timestamp('classified_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Outage windows ─────────────────────────────────────────────────
export const outageWindows = pgTable('outage_windows', {
  id: uuid('id').primaryKey().defaultRandom(),
  cohortKey: text('cohort_key').notNull(),
  issuer: text('issuer'),
  method: text('method'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  peakDeclineRate: numeric('peak_decline_rate', { precision: 5, scale: 4 }),
  eventsAffected: integer('events_affected').default(0),
  paiseParked: bigint('paise_parked', { mode: 'number' }).default(0),
  detectedBy: text('detected_by').notNull(), // 'classifier'|'downtime_api'|'both'
  downtimeApiStart: timestamp('downtime_api_start', { withTimezone: true }),
  downtimeApiEnd: timestamp('downtime_api_end', { withTimezone: true }),
  detectionLeadS: integer('detection_lead_s'), // negative = API saw it first
});

// ─── Policy ─────────────────────────────────────────────────────────
export const policies = pgTable('policies', {
  version: text('version').primaryKey(), // '3.2'
  yamlSource: text('yaml_source').notNull(),
  parsed: jsonb('parsed').notNull(),
  status: text('status').notNull(), // 'draft'|'live'|'archived'
  publishedAt: timestamp('published_at', { withTimezone: true }),
  author: text('author'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const policyEvaluations = pgTable('policy_evaluations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  eventId: text('event_id')
    .notNull()
    .references(() => paymentEvents.id),
  policyVersion: text('policy_version')
    .notNull()
    .references(() => policies.version),
  // 'allow:contact_window,under_caps' | 'block:cap_exceeded' | 'block:outside_window'
  // 'block:opted_out' | 'block:breaker_open' | 'defer:next_window@2026-09-04T08:00+05:30'
  gateResult: text('gate_result').notNull(),
  rulesTrace: jsonb('rules_trace').notNull(), // [{rule,expected,actual,pass}]
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
  isReplay: boolean('is_replay').notNull().default(false),
  replayRunId: uuid('replay_run_id'),
});

// ─── Experiment arms ────────────────────────────────────────────────
export const armAssignments = pgTable('arm_assignments', {
  eventId: text('event_id')
    .primaryKey()
    .references(() => paymentEvents.id),
  arm: armT('arm').notNull(),
  saltVersion: text('salt_version').notNull(),
  hashInput: text('hash_input').notNull(), // reproducible: event_id + salt
  bucket: smallint('bucket').notNull(), // 0-99
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Recovery attempts ──────────────────────────────────────────────
export const recoveryAttempts = pgTable(
  'recovery_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: text('event_id')
      .notNull()
      .references(() => paymentEvents.id),
    attemptNo: smallint('attempt_no').notNull(),
    // upi_payment_link|card_retry_delayed|netbanking_link|mandate_repair|
    // whatsapp_nudge|email_link|voice_hinglish|human_escalation|do_nothing
    rail: text('rail').notNull(),
    chosenBy: text('chosen_by').notNull(), // 'bandit'|'static_table'|'naive_fixed'
    railScores: jsonb('rail_scores'), // alternatives considered
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    razorpayLinkId: text('razorpay_link_id'),
    // 'paid'|'no_response'|'failed_technical'|'cancelled_payment_succeeded'|'stopped'
    outcome: text('outcome'),
    outcomeAt: timestamp('outcome_at', { withTimezone: true }),
    costPaise: integer('cost_paise').notNull().default(0),
  },
  (t) => [unique('recovery_attempts_event_attempt_uq').on(t.eventId, t.attemptNo)],
);

// ─── Messages ───────────────────────────────────────────────────────
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  attemptId: uuid('attempt_id')
    .notNull()
    .references(() => recoveryAttempts.id),
  channel: text('channel').notNull(), // whatsapp|email|sms|voice
  language: text('language').notNull().default('en'), // en|hi|hinglish
  body: text('body').notNull(),
  llmModel: text('llm_model'),
  llmPromptHash: text('llm_prompt_hash'),
  llmTokensIn: integer('llm_tokens_in'),
  llmTokensOut: integer('llm_tokens_out'),
  usedFallback: boolean('used_fallback').notNull().default(false),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  repliedBody: text('replied_body'),
  costPaise: integer('cost_paise').notNull().default(0),
});

// ─── Bandit state (FEATURE_BANDIT=false for v1; table ships anyway) ──
export const banditArms = pgTable(
  'bandit_arms',
  {
    failureClass: text('failure_class').notNull(),
    rail: text('rail').notNull(),
    alpha: numeric('alpha').notNull().default('1'), // Beta prior successes
    beta: numeric('beta').notNull().default('1'), // Beta prior failures
    pulls: integer('pulls').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('bandit_arms_pk').on(t.failureClass, t.rail)],
);

// ─── Audit ledger (hash-chained, append-only) ───────────────────────
export const auditLedger = pgTable(
  'audit_ledger',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    eventId: text('event_id'),
    failureClass: text('failure_class'),
    policyVersion: text('policy_version'),
    gateResult: text('gate_result'),
    arm: armT('arm'),
    llmPromptHash: text('llm_prompt_hash'),
    action: text('action').notNull(),
    outcome: text('outcome'),
    costPaise: integer('cost_paise').notNull().default(0),
    actor: text('actor').notNull().default('system'), // or 'operator:meera'
    detail: jsonb('detail'),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [uniqueIndex('audit_ledger_hash_uq').on(t.hash)],
);

// ─── Replay runs ────────────────────────────────────────────────────
export const replayRuns = pgTable('replay_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  corpus: text('corpus').notNull(),
  policyVersion: text('policy_version').notNull(),
  flags: jsonb('flags').notNull(), // {disable_llm:true, use_static_rails:true}
  seed: bigint('seed', { mode: 'number' }).notNull(),
  eventsCount: integer('events_count'),
  metrics: jsonb('metrics'),
  baselineMetrics: jsonb('baseline_metrics'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

// ─── Metric snapshots (5-min rollups powering the dashboard) ────────
export const metricSnapshots = pgTable(
  'metric_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    arm: armT('arm').notNull(),
    nEvents: integer('n_events'),
    nRecovered: integer('n_recovered'),
    grossPaise: bigint('gross_paise', { mode: 'number' }),
    costPaise: bigint('cost_paise', { mode: 'number' }),
    falseNudges: integer('false_nudges'),
  },
  (t) => [unique('metric_snapshots_window_arm_uq').on(t.windowStart, t.arm)],
);

export const holidaysCache = pgTable('holidays_cache', {
  d: date('d').primaryKey(),
  name: text('name'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Dead-letter for Inngest jobs (blueprint 6.6), surfaced in /settings ──
export const failedJobs = pgTable('failed_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobName: text('job_name').notNull(),
  eventId: text('event_id'),
  step: text('step'),
  attempts: integer('attempts').notNull().default(0),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  payload: jsonb('payload'),
  failedAt: timestamp('failed_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Rolling cohort counters.
 *
 * The blueprint puts these in a Redis sorted set (6.5, step 3). Upstash is not
 * provisioned yet, so this is the sanctioned Postgres fallback: one row per
 * (cohort dimension × 5-minute bucket), incremented on every observed payment
 * outcome. The decline rate for a 15-minute window is a SUM over three rows.
 * The `CohortStore` interface in src/core/triage/cohort-store.ts keeps the
 * swap to Redis a one-file change.
 */
export const cohortCounters = pgTable(
  'cohort_counters',
  {
    cohortDim: text('cohort_dim').notNull(), // 'HDFC|card'
    bucketStart: timestamp('bucket_start', { withTimezone: true }).notNull(), // 5-min floor
    nTotal: integer('n_total').notNull().default(0),
    nFailed: integer('n_failed').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('cohort_counters_pk').on(t.cohortDim, t.bucketStart),
    index('cohort_counters_bucket_idx').on(t.bucketStart.desc()),
  ],
);

/**
 * EWMA baseline decline rate per cohort dimension (blueprint 6.5, α=0.3).
 * Kept in Postgres for the same reason as cohort_counters.
 */
export const cohortBaselines = pgTable('cohort_baselines', {
  cohortDim: text('cohort_dim').primaryKey(),
  ewmaRate: numeric('ewma_rate', { precision: 6, scale: 5 }).notNull(),
  ewmaVar: numeric('ewma_var', { precision: 8, scale: 7 }).notNull(),
  samples: integer('samples').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
