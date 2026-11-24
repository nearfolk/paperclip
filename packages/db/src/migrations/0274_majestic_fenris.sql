CREATE TABLE "heartbeat_delivered_transitions" (
	"company_id" uuid NOT NULL,
	"transition_key" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"issue_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "heartbeat_delivered_transitions_company_id_transition_key_pk" PRIMARY KEY("company_id","transition_key")
);
--> statement-breakpoint
CREATE TABLE "heartbeat_progress_outcomes" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"outcome" text DEFAULT 'unknown' NOT NULL,
	"reason" text NOT NULL,
	"model_invoked" boolean DEFAULT false NOT NULL,
	"finished_at" timestamp with time zone,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" double precision
);
--> statement-breakpoint
CREATE TABLE "heartbeat_progress_receipts" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "heartbeat_progress_receipts_company_id_agent_id_event_key_pk" PRIMARY KEY("company_id","agent_id","event_key")
);
--> statement-breakpoint
CREATE TABLE "heartbeat_progress_state" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"fingerprint" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"consecutive_no_ops" integer DEFAULT 0 NOT NULL,
	"timers_suppressed" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "heartbeat_delivered_transitions" ADD CONSTRAINT "heartbeat_delivered_transitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_delivered_transitions" ADD CONSTRAINT "heartbeat_delivered_transitions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_delivered_transitions" ADD CONSTRAINT "heartbeat_delivered_transitions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_progress_outcomes" ADD CONSTRAINT "heartbeat_progress_outcomes_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_progress_outcomes" ADD CONSTRAINT "heartbeat_progress_outcomes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_progress_outcomes" ADD CONSTRAINT "heartbeat_progress_outcomes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_progress_receipts" ADD CONSTRAINT "heartbeat_progress_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_progress_receipts" ADD CONSTRAINT "heartbeat_progress_receipts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_progress_receipts" ADD CONSTRAINT "heartbeat_progress_receipts_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_progress_state" ADD CONSTRAINT "heartbeat_progress_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_progress_state" ADD CONSTRAINT "heartbeat_progress_state_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "heartbeat_delivered_transitions_agent_idx" ON "heartbeat_delivered_transitions" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "heartbeat_progress_outcomes_agent_idx" ON "heartbeat_progress_outcomes" USING btree ("company_id","agent_id");