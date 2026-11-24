# Run-context writes and failure containment

## Authorization contract

A run header selects persisted context; it is not permission to write. JWT identity remains authoritative. Conflicting headers are rejected. API-key headers are trimmed and validated before UUID queries. Issue mutations require an active, unfinished run owned by the authenticated agent and company. Source references come only from persisted `contextSnapshot.issueId`, `contextSnapshot.taskId`, and `nativeIssueId`. Every supplied reference must resolve to the same company-owned issue. A different current execution run invalidates the stale source binding. Signed JWT calls may omit the header because their claim supplies it; API-key issue writes may not.

Scope, review confinement, responsible-user checks and the atomic cross-issue cap still decide whether a target mutation is allowed. Source validation does not grant sibling access. The historical supplied-header failure receipt alone does not establish a regression: a header without a valid persisted source must fail. The native-only fixture reproduces the concrete missing-source path in the prior limiter.

## Canonical identity and secret handling

The guard, error handler and HTTP logger share `issueWriteRoute`. Express accepts case-insensitive route literals and optional trailing slashes. Issue parameters are decoded once, then resolved inside the authenticated company. UUID, accepted PostgreSQL UUID spelling, and normalized issue identifiers map to the same stored issue ID. Query and body values never enter the budget. The budget intentionally groups all subresources of a resolved issue by HTTP method; it does not lowercase case-sensitive document keys or filenames. Unresolved resources share one conservative budget.

Agent issue errors omit request data and use fixed crash metadata. HTTP logs for issue mutations omit bodies, headers, query values and resource paths, including failures returned directly without an exception. Existing sanitized chat-setup metadata remains available. Canary tests cover mixed-case response, error context, crash and serialized HTTP log sinks.

## Durable budgets and incidents

Before an issue mutation, a run-row lock serializes activity-ledger reservations across clients and replicas. Two failed or unresolved attempts block further attempts for that operation and heartbeat. Success releases a slot. An unresolved reservation remains charged after process loss. Ambiguous mutations are never automatically replayed.

Native `call_api` reserves a separate transport budget before dispatch, using the same resolved issue identity. Transport exceptions settle as failures; receiving a response releases the transport slot because the issue HTTP guard accounts for route failures. Native call-ID receipts continue to prevent ambiguous replay.

A company-row lock serializes incident creation and occurrence updates. One company/category/normalized-cause incident is reused on recurrence. Counts live in `control_plane.incident_summary` activity records. Settlement and occurrence updates are idempotent and transactional. The assigned CTO or responsible board user owns triage. Classifications distinguish infrastructure, transport, authentication/context, policy and application failures; raw exceptions and bodies never become incident keys.

## Notification outbox

Initial creation and every closed-to-open recurrence commit a `control_plane.notification_pending` activity record in the same transaction as the incident. Each record supplies a distinct `control-plane-incident:v2:<outbox UUID>` key. Migration 0274 adds a partial unique wake-receipt index for this new namespace. It leaves older keys and skipped policy receipts outside that uniqueness constraint. The repository migration runner is transactional and cannot use CONCURRENTLY. Following its existing partial-index migration pattern, this statement has a narrowly documented migration-safety exception plus a five-second lock timeout and 30-second statement timeout. A busy/large deployment fails the migration rather than waiting indefinitely; CTO must schedule and review this rollout risk.

Workers claim pending records with row locks and persisted leases/backoff. Delivery has a five-second timeout and at most eight attempts. A completed callback alone is insufficient: a non-skipped persisted wake receipt acknowledges delivery. Restart reconciliation finds receipts after a crash between enqueue and acknowledgement. The receiver index prevents concurrent or late deliveries from multiplying effective wakes. Skipped receipts retain intent for later retry. After eight attempts, the intent remains inspectable and receipt reconciliation continues, but no new delivery attempt is made; the runtime operator must repair delivery and arrange a fresh authorized notification path. No endpoint to reset the attempt count is introduced.

The application reconciles on startup and every 30 seconds, with one sweep in flight per process. Middleware can kick reconciliation after settlement. HTTP completion does not await notification delivery and is bounded while settlement is pending. Scheduler state modules are unchanged.

## Storage outages and supported legacy transport

`control-plane-intents` in adapter-utils stores host-owned, mode-0600 intent files under the instance storage directory. Slots use exclusive filesystem links after complete file write/fsync. A directory fsync precedes dispatch. Only generated IDs, run IDs, a fixed failure kind, optional reservation ID and numeric HTTP status are retained. No body, token, URL, response or raw exception is persisted. Failed and unresolved slots survive bridge recreation and process restart. Successful slots are removed.

There are two slots per run and lane (storage or transport), deliberately stricter than per-operation accounting. The directory refuses new admission at 4,096 entries; concurrent admissions can transiently exceed that threshold by the number of in-flight admissions. Reconciliation reads at most 4,096 slots per sweep. An unmarked reservation becomes reportable after five minutes; a recorded failure is immediately reportable. Corrupt intent files stay charged and are not replayed. Terminal-run files are removed only after incident settlement commits. Active-run files stay charged.

Server reservation/settlement and native pre-dispatch storage operations fail closed on storage errors and retain replayable reporting intent. Recovery resolves agent/company from the persisted run, inserts an idempotent reporting reservation where needed, and settles the incident. It never sends the original mutation. A previously existing reservation is settled using its original ID.

The existing adapter-owned entry point is `startAdapterExecutionTargetPaperclipBridge` in `packages/adapter-utils/src/execution-target.ts`. Both `queue_v1` and `http2_v1` call its `forwardBridgeRequest`. Its persistent transport slots cover failures before HTTP response, non-success HTTP status and response-body read failure; the third attempt returns non-retryable containment before forwarding. A recreated bridge retains the same budget. Host-side authentication replacement and route allowlists remain in place.

Residual limits: arbitrary host curl and local adapters that bypass this bridge cannot be contained when the API is unreachable. Lost disks or simultaneous database/filesystem failure cannot provide durable reporting; admission still fails closed where this code runs. Every replica needs retained instance storage for its own outstanding intents. CTO must certify the deployed integration and actual transport target. These tests do not claim universal client containment.

## Verification and CI repairs

The real-PostgreSQL reliability suite covers valid/invalid source contexts, accepted URL aliases, two-failure budgets, concurrent reporters, incident reuse, unique wake receipts, reopening, delivery timeout/exhaustion, crash-after-enqueue, skipped-wake retry, restart recovery, storage outages and native transport aliases. It fails if PostgreSQL support is unavailable. The bridge suite exercises actual file and HTTP/2 relay paths plus recreation and content-size bounds.

Run the focused suites listed in the implementation handoff, including `control-plane-write-reliability-postgres`, `control-plane-failures`, `agent-auth-middleware`, both cross-issue influence suites, interaction cross-issue-cap PostgreSQL, low-trust routes, error handler, HTTP log redaction, runner API, shared issue-write-denial, execution-policy routes, telemetry routes and adapter execution-target sandbox tests. Use disposable PostgreSQL only. Normal server typecheck includes dependency preparation; validate adapter-utils and db typechecks as well. Frozen installation is required.

CI repairs retain production guards: execution-policy and telemetry fixtures now model running/unfinished runs and company-scoped source queries. The rollback test's one-shot activity rejection is reset between tests. HTTP chat-setup metadata remains sanitized. The svix importer and transitive lockfile entries are restored. Dependency review exposed uuid 10 through svix; both workspace override surfaces pin svix to patched uuid 11.1.1 (GHSA-w5hq-g745-h8pq), with webhook integration coverage. The requested frozen lockfile repair is retained in the candidate, but the trusted PR workflow rejects manual lockfile diffs. CTO must choose the supported CI-owned promotion/integration path; this candidate does not disable or impersonate that gate.

The signoff e2e fixture previously used an immediately exiting process and accepted terminal run receipts. Its source now holds the process briefly, waits for a running unfinished issue-bound receipt, and limits mutation retries to two. No browser/e2e execution was performed under the ancestor hold. CI must verify this source repair. The missing `COMMITPERCLIP_KEY` remains with CTO; no review gate was weakened.

## Rollout and rollback

This is a draft candidate, not a deployment authorization. CTO owns integration, migration rollout and runtime certification. Live health reports 0.3.1 without a source commit. Review base `94f4c8a5b56eb848d986bd952119dfc3b19d4caf` is not a certified deployment baseline. Integrate scheduling changes separately and rerun gates on the combined head. Keep heartbeat timers disabled and wake-on-demand enabled until deployed acceptance.

Require independent QA, explicit exact-head retraction of the prior FAIL by its author, CTO security/integration review, branch freshness and required CI for the same 40-character head. CTO is merge operator and must not be the verdict author. No GitHub approval or routine board approval is required. The current explicit draft/no-merge/no-deploy hold remains.

Rollback code on the certified integration branch through the same release process. Retain ledger, outbox and intent records; do not delete them to reset budgets. The additive partial index can remain during code rollback. A rollback disables reconciliation until the compatible code returns; operators must preserve pending evidence. No production database, credential, configuration or service lifecycle change is performed by this candidate work.
