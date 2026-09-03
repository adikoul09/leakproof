CREATE TABLE "breaker_state" (
	"scope" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'closed' NOT NULL,
	"trigger_source" text,
	"observed_value" numeric(6, 5),
	"threshold" numeric(6, 5),
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"actor" text DEFAULT 'system' NOT NULL,
	"override_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
