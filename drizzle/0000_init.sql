CREATE TYPE "public"."arm_t" AS ENUM('control', 'naive', 'leakproof');--> statement-breakpoint
CREATE TYPE "public"."event_state_t" AS ENUM('at_risk', 'classifying', 'planned', 'waiting_out_outage', 'deferred', 'blocked_by_policy', 'action_sent', 'recovered', 'lost', 'stopped');--> statement-breakpoint
CREATE TYPE "public"."failure_kind_t" AS ENUM('systemic', 'idiosyncratic', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."surface_t" AS ENUM('payment', 'subscription', 'invoice');--> statement-breakpoint
CREATE TABLE "arm_assignments" (
	"event_id" text PRIMARY KEY NOT NULL,
	"arm" "arm_t" NOT NULL,
	"salt_version" text NOT NULL,
	"hash_input" text NOT NULL,
	"bucket" smallint NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_ledger" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"event_id" text,
	"failure_class" text,
	"policy_version" text,
	"gate_result" text,
	"arm" "arm_t",
	"llm_prompt_hash" text,
	"action" text NOT NULL,
	"outcome" text,
	"cost_paise" integer DEFAULT 0 NOT NULL,
	"actor" text DEFAULT 'system' NOT NULL,
	"detail" jsonb,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bandit_arms" (
	"failure_class" text NOT NULL,
	"rail" text NOT NULL,
	"alpha" numeric DEFAULT '1' NOT NULL,
	"beta" numeric DEFAULT '1' NOT NULL,
	"pulls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bandit_arms_pk" UNIQUE("failure_class","rail")
);
--> statement-breakpoint
CREATE TABLE "classifications" (
	"event_id" text PRIMARY KEY NOT NULL,
	"kind" "failure_kind_t" NOT NULL,
	"failure_class" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"cohort_key" text NOT NULL,
	"cohort_decline_rate" numeric(5, 4),
	"cohort_n" integer,
	"downtime_api_agrees" boolean,
	"outage_window_id" uuid,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cohort_baselines" (
	"cohort_dim" text PRIMARY KEY NOT NULL,
	"ewma_rate" numeric(6, 5) NOT NULL,
	"ewma_var" numeric(8, 7) NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cohort_counters" (
	"cohort_dim" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"n_total" integer DEFAULT 0 NOT NULL,
	"n_failed" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cohort_counters_pk" UNIQUE("cohort_dim","bucket_start")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"phone_hash" text NOT NULL,
	"phone_masked" text NOT NULL,
	"email_hash" text,
	"email_masked" text,
	"opted_out_at" timestamp with time zone,
	"opt_out_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "failed_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"event_id" text,
	"step" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"payload" jsonb,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holidays_cache" (
	"d" date PRIMARY KEY NOT NULL,
	"name" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"body" text NOT NULL,
	"llm_model" text,
	"llm_prompt_hash" text,
	"llm_tokens_in" integer,
	"llm_tokens_out" integer,
	"used_fallback" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"replied_body" text,
	"cost_paise" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"arm" "arm_t" NOT NULL,
	"n_events" integer,
	"n_recovered" integer,
	"gross_paise" bigint,
	"cost_paise" bigint,
	"false_nudges" integer,
	CONSTRAINT "metric_snapshots_window_arm_uq" UNIQUE("window_start","arm")
);
--> statement-breakpoint
CREATE TABLE "outage_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort_key" text NOT NULL,
	"issuer" text,
	"method" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"peak_decline_rate" numeric(5, 4),
	"events_affected" integer DEFAULT 0,
	"paise_parked" bigint DEFAULT 0,
	"detected_by" text NOT NULL,
	"downtime_api_start" timestamp with time zone,
	"downtime_api_end" timestamp with time zone,
	"detection_lead_s" integer
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"surface" "surface_t" NOT NULL,
	"customer_id" text,
	"amount_paise" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"method" text,
	"issuer" text,
	"card_network" text,
	"amount_band" text,
	"time_bucket" smallint,
	"err_code" text,
	"err_description" text,
	"err_source" text,
	"err_step" text,
	"err_reason" text,
	"state" "event_state_t" DEFAULT 'at_risk' NOT NULL,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"failed_at" timestamp with time zone NOT NULL,
	"recovered_at" timestamp with time zone,
	"recovered_paise" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"version" text PRIMARY KEY NOT NULL,
	"yaml_source" text NOT NULL,
	"parsed" jsonb NOT NULL,
	"status" text NOT NULL,
	"published_at" timestamp with time zone,
	"author" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_evaluations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"policy_version" text NOT NULL,
	"gate_result" text NOT NULL,
	"rules_trace" jsonb NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_replay" boolean DEFAULT false NOT NULL,
	"replay_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "recovery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"attempt_no" smallint NOT NULL,
	"rail" text NOT NULL,
	"chosen_by" text NOT NULL,
	"rail_scores" jsonb,
	"scheduled_for" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"razorpay_link_id" text,
	"outcome" text,
	"outcome_at" timestamp with time zone,
	"cost_paise" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "recovery_attempts_event_attempt_uq" UNIQUE("event_id","attempt_no")
);
--> statement-breakpoint
CREATE TABLE "replay_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corpus" text NOT NULL,
	"policy_version" text NOT NULL,
	"flags" jsonb NOT NULL,
	"seed" bigint NOT NULL,
	"events_count" integer,
	"metrics" jsonb,
	"baseline_metrics" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_receipts" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"signature" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "arm_assignments" ADD CONSTRAINT "arm_assignments_event_id_payment_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."payment_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_event_id_payment_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."payment_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_attempt_id_recovery_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."recovery_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_evaluations" ADD CONSTRAINT "policy_evaluations_event_id_payment_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."payment_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_evaluations" ADD CONSTRAINT "policy_evaluations_policy_version_policies_version_fk" FOREIGN KEY ("policy_version") REFERENCES "public"."policies"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_attempts" ADD CONSTRAINT "recovery_attempts_event_id_payment_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."payment_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_ledger_hash_uq" ON "audit_ledger" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "cohort_counters_bucket_idx" ON "cohort_counters" USING btree ("bucket_start" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_events_state_failed_at_idx" ON "payment_events" USING btree ("state","failed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_events_cohort_idx" ON "payment_events" USING btree ("issuer","method","failed_at" DESC NULLS LAST);--> statement-breakpoint
-- ─── Audit ledger is append-only (blueprint 6.3) ────────────────────
-- The hash chain is only worth anything if a row cannot be quietly rewritten.
-- Enforced in the database, not in application code, so it holds even for a
-- direct psql session.
CREATE OR REPLACE FUNCTION audit_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_ledger is append-only: % on seq % is not permitted',
    TG_OP, COALESCE(OLD.seq, NEW.seq);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_ledger_no_update
  BEFORE UPDATE OR DELETE ON audit_ledger
  FOR EACH ROW EXECUTE FUNCTION audit_ledger_append_only();
