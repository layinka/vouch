CREATE TYPE "public"."outcome" AS ENUM('Ok', 'Disputed', 'Failed');--> statement-breakpoint
CREATE TABLE "agents" (
	"erc8004_id" text PRIMARY KEY NOT NULL,
	"ens_name" text,
	"uaid" text,
	"node" text,
	"resolver" text,
	"owner" text,
	"total_jobs" integer DEFAULT 0 NOT NULL,
	"ok_jobs" integer DEFAULT 0 NOT NULL,
	"disputed_jobs" integer DEFAULT 0 NOT NULL,
	"failed_jobs" integer DEFAULT 0 NOT NULL,
	"unique_counterparties" integer DEFAULT 0 NOT NULL,
	"dispute_rate_bps" integer DEFAULT 0 NOT NULL,
	"settled_value" numeric(78, 0) DEFAULT '0' NOT NULL,
	"score" integer,
	"components" jsonb,
	"verdict" text,
	"computed_at" timestamp with time zone,
	"anchor_tx" text,
	"ens_tx" text,
	"published_score" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attestations" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"attestor" text NOT NULL,
	"job_ref" text NOT NULL,
	"outcome" "outcome" NOT NULL,
	"value" numeric(78, 0) DEFAULT '0' NOT NULL,
	"dispute_reason" text,
	"disputed_at" bigint,
	"timestamp" bigint NOT NULL,
	"block" bigint NOT NULL,
	"tx_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"position" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lookups" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text,
	"agent_name" text,
	"payer_account" text NOT NULL,
	"asset" text NOT NULL,
	"amount" text NOT NULL,
	"hedera_tx_id" text,
	"hcs_sequence" bigint,
	"score_served" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "score_history" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"score" integer NOT NULL,
	"components" jsonb NOT NULL,
	"evidence_root" text,
	"anchor_tx" text,
	"ens_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agents_ens_name_idx" ON "agents" USING btree ("ens_name");--> statement-breakpoint
CREATE INDEX "agents_score_idx" ON "agents" USING btree ("score");--> statement-breakpoint
CREATE INDEX "attestations_agent_idx" ON "attestations" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "attestations_time_idx" ON "attestations" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "lookups_time_idx" ON "lookups" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "score_history_agent_time_idx" ON "score_history" USING btree ("agent_id","created_at");