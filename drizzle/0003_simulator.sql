-- Milestone 6: the synthetic data generator as a first-class repo citizen.

CREATE TABLE IF NOT EXISTS "synthetic_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "label" text,
  "spec" jsonb NOT NULL,
  "summary" jsonb,
  "ground_truth" jsonb,
  "status" text DEFAULT 'generating' NOT NULL,
  "error" text,
  "n_events" integer DEFAULT 0 NOT NULL,
  "n_accepted" integer DEFAULT 0 NOT NULL,
  "n_rejected" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "unmatched_recoveries" (
  "payment_id" text PRIMARY KEY NOT NULL,
  "order_id" text,
  "subscription_id" text,
  "amount_paise" bigint NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "matched_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "unmatched_recoveries_order_idx" ON "unmatched_recoveries" ("order_id");

ALTER TABLE "payment_events" ADD COLUMN IF NOT EXISTS "batch_id" uuid;
CREATE INDEX IF NOT EXISTS "payment_events_batch_idx" ON "payment_events" ("batch_id");
