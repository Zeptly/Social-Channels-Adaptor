-- Gateway refactor: social_connections → gateway_connections (Gateway Contract v1).
-- Metadata-only renames: no data is copied or rewritten, ids and ownership rows
-- are untouched. Constraint/index names follow the new table name so the
-- drizzle snapshot stays authoritative.
ALTER TABLE "social_connections" RENAME TO "gateway_connections";--> statement-breakpoint
ALTER TABLE "gateway_connections" RENAME CONSTRAINT "social_connections_pkey" TO "gateway_connections_pkey";--> statement-breakpoint
ALTER TABLE "gateway_connections" RENAME CONSTRAINT "social_connections_workspace_id_workspaces_id_fk" TO "gateway_connections_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "provider_accounts" RENAME CONSTRAINT "provider_accounts_connection_id_social_connections_id_fk" TO "provider_accounts_connection_id_gateway_connections_id_fk";--> statement-breakpoint
ALTER TABLE "social_conversations" RENAME CONSTRAINT "social_conversations_connection_id_social_connections_id_fk" TO "social_conversations_connection_id_gateway_connections_id_fk";--> statement-breakpoint
ALTER TABLE "social_metrics" RENAME CONSTRAINT "social_metrics_connection_id_social_connections_id_fk" TO "social_metrics_connection_id_gateway_connections_id_fk";--> statement-breakpoint
ALTER TABLE "social_post_targets" RENAME CONSTRAINT "social_post_targets_connection_id_social_connections_id_fk" TO "social_post_targets_connection_id_gateway_connections_id_fk";--> statement-breakpoint
ALTER INDEX "social_connections_workspace_idx" RENAME TO "gateway_connections_workspace_idx";--> statement-breakpoint
-- Compatibility for one release: a simple (auto-updatable) view under the old
-- name so a previous-version process still running during a rolling deploy
-- keeps working. Drop it in the release after this one (docs/RUNBOOK.md).
CREATE VIEW "social_connections" AS SELECT * FROM "gateway_connections";
