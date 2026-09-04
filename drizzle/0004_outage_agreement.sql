-- Milestone M3: three-valued downtime agreement on the outage window itself.
-- NULL = the feed had no rows for this method, so no opinion.
-- false = it covered the method and did not flag this cohort.
ALTER TABLE "outage_windows" ADD COLUMN IF NOT EXISTS "downtime_api_agrees" boolean;
ALTER TABLE "outage_windows" ADD COLUMN IF NOT EXISTS "downtime_api_why" text;
