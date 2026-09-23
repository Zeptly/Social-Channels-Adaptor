CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"action" text NOT NULL,
	"actor_service" text,
	"actor_agent" text,
	"resource_type" text,
	"resource_id" uuid,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"operation" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"dedupe_key" text,
	"workspace_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"network" text NOT NULL,
	"tenant_ref" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_accounts_connection_id_unique" UNIQUE("connection_id")
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"provider" text NOT NULL,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"resource_type" text,
	"resource_id" uuid,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provisioning_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"network" text NOT NULL,
	"provider" text NOT NULL,
	"strategy" text NOT NULL,
	"status" text NOT NULL,
	"state_hash" text,
	"return_url" text,
	"authorization_url" text,
	"provider_session_token" text,
	"options" jsonb,
	"reconnect_connection_id" uuid,
	"connection_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provisioning_sessions_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
CREATE TABLE "social_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"network" text NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"status_reason" text,
	"display_name" text,
	"username" text,
	"avatar_url" text,
	"account_type" text,
	"connected_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"network" text NOT NULL,
	"kind" text DEFAULT 'direct_message' NOT NULL,
	"participant" jsonb NOT NULL,
	"last_message_at" timestamp with time zone,
	"last_message_preview" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text NOT NULL,
	"kind" text NOT NULL,
	"source_type" text NOT NULL,
	"source_url" text,
	"asset_ref" text,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint,
	"provider" text NOT NULL,
	"provider_media_id" text,
	"provider_url" text,
	"provider_expires_at" timestamp with time zone,
	"upload_expires_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"external_id" text,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"text" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"idempotency_key" text,
	"sent_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid,
	"post_id" uuid,
	"target_id" uuid,
	"network" text NOT NULL,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"provider" text NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_post_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"publication_id" uuid,
	"network" text NOT NULL,
	"content" jsonb,
	"options" jsonb,
	"status" text NOT NULL,
	"platform_post_id" text,
	"platform_post_url" text,
	"published_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text NOT NULL,
	"content" jsonb NOT NULL,
	"external_ref" text,
	"scheduled_at" timestamp with time zone,
	"timezone" text,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_by" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"network" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"publish_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"idempotency_key" uuid,
	"idempotency_key_created_at" timestamp with time zone,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"provider_post_id" text,
	"handed_off_at" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"metrics_fetched_at" timestamp with time zone,
	"last_error_code" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"timezone" text,
	"status" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_schedules_post_id_unique" UNIQUE("post_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_type" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"workspace_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_beat_at" timestamp with time zone NOT NULL,
	"version" text
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"provider_tenant_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "workspaces_provider_tenant_ref_unique" UNIQUE("provider_tenant_ref")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_connection_id_social_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisioning_sessions" ADD CONSTRAINT "provisioning_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_conversations" ADD CONSTRAINT "social_conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_conversations" ADD CONSTRAINT "social_conversations_connection_id_social_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_media" ADD CONSTRAINT "social_media_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_messages" ADD CONSTRAINT "social_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_messages" ADD CONSTRAINT "social_messages_conversation_id_social_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."social_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_metrics" ADD CONSTRAINT "social_metrics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_metrics" ADD CONSTRAINT "social_metrics_connection_id_social_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_metrics" ADD CONSTRAINT "social_metrics_post_id_social_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."social_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_metrics" ADD CONSTRAINT "social_metrics_target_id_social_post_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."social_post_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_post_targets" ADD CONSTRAINT "social_post_targets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_post_targets" ADD CONSTRAINT "social_post_targets_post_id_social_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."social_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_post_targets" ADD CONSTRAINT "social_post_targets_connection_id_social_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_post_targets" ADD CONSTRAINT "social_post_targets_publication_id_social_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."social_publications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_publications" ADD CONSTRAINT "social_publications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_publications" ADD CONSTRAINT "social_publications_post_id_social_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."social_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_schedules" ADD CONSTRAINT "social_schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_schedules" ADD CONSTRAINT "social_schedules_post_id_social_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."social_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_workspace_idx" ON "audit_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_resource_idx" ON "audit_events" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_workspace_key_uq" ON "idempotency_keys" USING btree ("workspace_id","operation","key");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_active_dedupe_uq" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" in ('pending', 'running') and "jobs"."dedupe_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_provider_external_uq" ON "provider_accounts" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "provider_accounts_workspace_idx" ON "provider_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "provider_events_workspace_idx" ON "provider_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "provisioning_sessions_workspace_idx" ON "provisioning_sessions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "social_connections_workspace_idx" ON "social_connections" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "social_conversations_provider_external_uq" ON "social_conversations" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "social_conversations_workspace_idx" ON "social_conversations" USING btree ("workspace_id","last_message_at");--> statement-breakpoint
CREATE INDEX "social_media_workspace_idx" ON "social_media" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "social_messages_conversation_external_uq" ON "social_messages" USING btree ("conversation_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_messages_conversation_idem_uq" ON "social_messages" USING btree ("conversation_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "social_messages_conversation_idx" ON "social_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "social_metrics_snapshot_uq" ON "social_metrics" USING btree ("target_id","metric","measured_at");--> statement-breakpoint
CREATE INDEX "social_metrics_workspace_idx" ON "social_metrics" USING btree ("workspace_id","post_id","measured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "social_post_targets_post_connection_uq" ON "social_post_targets" USING btree ("post_id","connection_id");--> statement-breakpoint
CREATE INDEX "social_post_targets_publication_idx" ON "social_post_targets" USING btree ("publication_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_posts_workspace_idem_uq" ON "social_posts" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "social_posts_workspace_idx" ON "social_posts" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "social_publications_provider_post_uq" ON "social_publications" USING btree ("provider","provider_post_id");--> statement-breakpoint
CREATE INDEX "social_publications_queue_idx" ON "social_publications" USING btree ("status","publish_at");--> statement-breakpoint
CREATE INDEX "social_publications_post_idx" ON "social_publications" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "social_schedules_due_idx" ON "social_schedules" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_uq" ON "webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_status_idx" ON "webhook_events" USING btree ("status","received_at");