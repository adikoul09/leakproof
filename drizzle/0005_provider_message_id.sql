-- WhatsApp is the only rail this system sends itself; every other rail is
-- delivered by Razorpay's notification on the payment link. Store the provider
-- message id so a delivery receipt can be reconciled back to the attempt.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "provider_message_id" text;
