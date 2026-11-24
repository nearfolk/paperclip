# Run-context writes and failure containment

## Contract

A run header selects persisted context; it is not permission to write. JWT identity remains authoritative. A conflicting header is rejected. API-key headers are trimmed and validated before UUID queries. Issue mutations require an active, unfinished run owned by the authenticated agent and company. Source references come only from persisted `contextSnapshot.issueId`, `contextSnapshot.taskId`, and `nativeIssueId`. All supplied references must resolve to the same company-owned issue. A different current execution run invalidates the stale source binding. Legacy JWT calls may omit the header because the signed run claim supplies it; API-key issue writes may not.

Existing scope, review confinement, responsible-user checks and the atomic cross-issue cap still decide whether the target mutation is allowed. Source validation does not grant sibling access. The historical supplied-header failure receipt alone does not establish a regression: a header with no valid persisted source must still fail. The new native-only fixture reproduces a concrete missing-source path in the prior limiter.

## Failure budget and incidents

The issue HTTP middleware reserves an activity-ledger slot before entering a mutation route. A run row lock serializes reservations across clients and replicas. Two failed or unresolved reservations stop further attempts to that operation for the heartbeat. Successful responses release their slot. An unresolved reservation remains charged after process loss; ambiguous writes are never automatically replayed. The budget is deliberately conservative: method and path identify an operation, while request bodies and query values do not reset it. Two failures remain charged for the heartbeat even if another call succeeds between them.

Native API dispatch separately reserves transport slots before sending mutations. Transport exceptions settle those slots as failures; receiving an HTTP response releases the transport slot because the issue HTTP guard accounts for route failures. Native mutation receipts continue to prevent replay of an ambiguous call ID.

Classification distinguishes infrastructure, transport, authentication/context, policy, and application failures. Only allowlisted infrastructure/transport causes are classified retryable. This label does not trigger an automatic mutation retry. Unknown error strings and response bodies never become incident keys.

A company row lock serializes incident creation and occurrence updates. Each company/category/normalized-cause has one incident, reused on recurrence. Counts live in `control_plane.incident_summary` activity records. Failed-attempt settlement and the incident update commit together. Repeated settlement is idempotent. The assigned CTO (or responsible board user) owns triage; the description names the required runtime/security/implementation action. Initial incident creation requests an assignment wake through the existing heartbeat API. Scheduler state modules are unchanged.

## Verification

Run these suites from the repository root:

```sh
pnpm exec vitest run \
  server/src/__tests__/control-plane-write-reliability-postgres.test.ts \
  server/src/__tests__/control-plane-failures.test.ts \
  server/src/__tests__/agent-auth-middleware.test.ts \
  server/src/__tests__/cross-issue-influence-limit.test.ts \
  server/src/__tests__/cross-issue-influence-limit-postgres.test.ts \
  server/src/__tests__/interaction-resolution-cross-issue-cap-postgres.test.ts \
  server/src/__tests__/low-trust-red-team-routes.test.ts \
  server/src/__tests__/error-handler.test.ts \
  server/src/services/native-runtime/runner-api.test.ts \
  packages/shared/src/issue-write-denial.test.ts
pnpm --filter @paperclipai/server typecheck
```

The PostgreSQL suites use disposable clusters and new clients/app instances to exercise durable reconstruction. They must execute, not skip. Install native dependency postinstall scripts: on macOS the embedded PostgreSQL package needs its own `hydrate-symlinks.js` script to restore packaged library aliases. No production database is used.

## Rollout and rollback

CTO owns rollout. First certify the deployed source SHA and the integration branch. The live health receipt reported version 0.3.1 with no source commit; the retained company branch is an implementation source, not a deployment certificate. Integrate scheduling changes separately and rerun the focused suites on the combined head. Require independent QA and team review, all required CI and freshness checks for that exact 40-character head. The merge operator must not be the QA verdict author. No GitHub approval or routine board approval is required.

Use a disposable staging instance to verify native-only and legacy run writes, mismatched/terminal source rejection, unauthorized sibling confinement, two failures followed by a blocked third attempt, concurrent reporters, and reconstruction from persisted state. Keep timer-only containment (`enabled=false`, `wakeOnDemand=true`) until deployed acceptance confirms the integrated behavior. This change makes no schema migration or credential change.

Rollback means reverting the code commit on the certified integration branch and passing the same release gates. Keep ledger and incident records as audit evidence. Do not delete them to reset budgets. Deployment and any service lifecycle action require the CTO's existing rollout process; this document performs none.

## Limits requiring integrated review

- A raw external client such as curl cannot be stopped by server middleware when the server is unreachable. Native `call_api` has the client-side transport budget; legacy adapters need equivalent integration before claiming universal transport containment.
- If the database is unavailable, reservation fails closed before the target route. This storage dependency prevents durable incident settlement until the database returns. It is not an offline incident outbox.
- Incident storage is atomic, but assignment notification occurs after commit. A process crash in that interval can leave the durable assigned incident without a delivered wake. Reopened incidents currently require owner triage; a durable notification outbox/reconciliation path is still needed for automatic restart-safe wake delivery.
- The operation budget groups differing payloads to the same method/path. This intentionally trades retry granularity for avoiding secret-derived fingerprints. There is no automatic TTL that releases an ambiguous reservation.

These limits are release-review inputs, not claims that the complete orchestration rollout is ready.
