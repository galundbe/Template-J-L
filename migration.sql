ALTER TABLE "bookings" ADD COLUMN "cancel_token" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "cancelled_at" timestamp;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancel_token_key" UNIQUE("cancel_token");