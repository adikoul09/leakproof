ALTER TABLE "payment_events" ADD COLUMN "order_id" text;--> statement-breakpoint
CREATE INDEX "payment_events_order_idx" ON "payment_events" USING btree ("order_id");