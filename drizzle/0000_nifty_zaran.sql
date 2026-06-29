CREATE TYPE "public"."outpost_lifecycle_state" AS ENUM('queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."outpost_suppression_reason" AS ENUM('hard_bounce', 'complaint', 'unsubscribe', 'invalid', 'manual');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outpost_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outpost_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid,
	"event_type" text NOT NULL,
	"actor" text NOT NULL,
	"detail" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outpost_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" "outpost_lifecycle_state" DEFAULT 'queued' NOT NULL,
	"recipient_hmac" text NOT NULL,
	"recipient_sealed" jsonb NOT NULL,
	"body_sealed" jsonb NOT NULL,
	"subject" text NOT NULL,
	"template_id" text,
	"template_version" integer,
	"provider" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduled_for" timestamp with time zone,
	"provider_message_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outpost_suppressions" (
	"recipient_hmac" text PRIMARY KEY NOT NULL,
	"reason" "outpost_suppression_reason" NOT NULL,
	"created_by" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outpost_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"type" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"recipient" text,
	"is_hard_bounce" boolean,
	"occurred_at" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outpost_api_keys_key_hash_uq" ON "outpost_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outpost_audit_message_id_idx" ON "outpost_audit_events" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outpost_audit_at_idx" ON "outpost_audit_events" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outpost_outbox_idempotency_key_uq" ON "outpost_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outpost_outbox_poll_idx" ON "outpost_outbox" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outpost_outbox_recipient_hmac_idx" ON "outpost_outbox" USING btree ("recipient_hmac");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outpost_outbox_provider_message_id_idx" ON "outpost_outbox" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outpost_webhook_provider_message_id_idx" ON "outpost_webhook_events" USING btree ("provider_message_id");