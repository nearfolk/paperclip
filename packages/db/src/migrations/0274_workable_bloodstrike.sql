-- Transactional migration runner cannot use CREATE INDEX CONCURRENTLY.
-- Fail rather than wait indefinitely for a busy production wake table.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '30s';
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: The transactional runner cannot build concurrently. This required uniqueness index covers only the new v2 incident namespace, with a 5s lock timeout and 30s build timeout; CTO must schedule rollout and an exceeded timeout rolls back the migration.
CREATE UNIQUE INDEX "agent_wakeup_requests_control_plane_incident_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'control-plane-incident:v2:%' AND "agent_wakeup_requests"."status" <> 'skipped';