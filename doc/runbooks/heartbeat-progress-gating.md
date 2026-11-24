# Deterministic heartbeat admission and progress v1

Paperclip can reject an unchanged wake before it reads task history, instruction
files, workspace configuration or provider credentials. This extends the existing
`runtimeConfig.heartbeat.skipTimerWhenNoActionableWork` policy. It adds no scheduler.
The policy remains opt-in for a bounded rollout; aliases retain their prior meaning.

## Admission

With that policy enabled, all wakes pass the same compact check at enqueue,
queue claim, before execution context hydration and before provider dispatch.
The check reads current ownership, status, dependency readiness (including the
workspace-finalization barrier), subtree holds, agent invokability and budgets.
An unresolved dependency rejects comment and manual wakes too. A review belongs
to its current typed participant; an assignee waiting on a human is not actionable.
Hidden tasks and tasks assigned to users are excluded from timer work.

An eligible assignment is `todo`, `in_progress` or `in_review`, owned by the agent,
with resolved dependencies and no hold. A blocked assignment alone is not work.
A valid relevant event can admit a context-only turn when no dependency blocks it:

- A human comment with nonempty content, excluding exact acknowledgements (`ack`,
  `acknowledged`, `thanks`, `thank you`), `ping`, `reminder` and `fyi`.
- A non-self agent comment explicitly marked with persisted metadata
  `wakeRelevance: "action_required"`.
- External persisted changes to title, description, assignment, execution policy,
  execution state or work mode; accepted/answered interactions; dependency-ready
  receipts. Wake reason strings alone are not evidence.
- A user manual wake with a persisted wake-request identity. An unscoped manual
  wake cannot bypass an otherwise entirely dependency-blocked queue.

`wakeRelevance: "none"` or `"reminder"` suppresses a comment. Self comments never
qualify. The supported comment API accepts this optional enum inside its existing
structured metadata envelope, for example
`{"version":1,"wakeRelevance":"action_required","sections":[{"rows":[{"type":"text","text":"Revised requirement needs action"}]}]}`.
The required version and sections remain unchanged. This field never bypasses
dependency, ownership, pause or budget checks.
Comment identity hashes normalized content, issue and author, so a new
comment ID with identical text is not new input. Content hashes are local, not
telemetry. This is a deterministic protocol, not semantic classification of prose;
callers should explicitly mark advisory comments. Human messages other than the
listed acknowledgements default to relevant. Comment receipts are claimed once
under a per-agent database row lock and survive restarts. The same admitted run
may revalidate its receipt. Another run may not reuse it.

Skipped enqueue attempts remain `agent_wakeup_requests.status=skipped` with
`payload.heartbeatSkip={version:1,outcome:"skipped_preflight",reason}`. They do not
create model runs or increment no-op streaks. Queued runs rejected at revalidation
are cancelled and have an explicit `skipped_preflight` progress outcome.

## Durable outcomes

Four additive tables hold state, input receipts, per-run outcomes and delivered
transitions. A process exit status never supplies a progress verdict:

| Outcome | Evidence |
| --- | --- |
| `skipped_preflight` | No provider dispatch; deterministic gate or setup stopped execution |
| `no_op` | Successful model turn without a persisted business mutation or artifact |
| `worked` | Persisted issue changes, document, attachment or work-product activity |
| `delivered_progress` | Newly credited completion or blocked-to-ready status transition |
| `failed` | Model turn failed without delivered evidence |
| `unknown` | Admission exists but finalization evidence is incomplete |

Completion credit is unique per company/task, including after reopen. Blocker
resolution credit is unique per persisted blocked-to-ready activity receipt and
requires current dependency readiness. Replayed finalization cannot double count.
A failed process may still have delivered progress. Comments and automatic run
summaries alone are not progress. These measurements cover persisted control-plane
evidence, not unseen workspace edits or the quality of a completion.

Two consecutive `no_op` finalizations with no actionable assignments set durable
timer suppression. Skips do not count as model no-ops. With deterministic admission,
an unchanged empty queue is skipped immediately; there is no need to spend two
turns to establish it. The streak can still arise from in-flight runs whose work
became non-actionable. New actionable assignment/context, relevant comments,
dependency resolution or manual input resets suppression when admitted. A
monotonic generation fences late finalization from earlier concurrent runs.
An interrupted finalizer leaves `unknown`; it never fabricates a no-op or delivery.

The board-authorized `GET /api/agents/:id/progress-summary` and typed UI client
expose no-op/skipped/model counts, successful turns, unique delivered transitions,
suppression, input/output tokens, measured USD and unknown-cost run count.
`measuredCostUsd=0` is not a statement that total cost is zero. Missing prices,
`unpriced` usage and subscription-included usage contribute unknown-cost runs.
No historical run is backfilled as measured or delivered.

Incident classification and deduplication remain a separate contract owned by the
reliability service. It can join company/agent/run identities to these outcomes.
Neither incident prose nor adapter result text can create delivered credit or
reset timer suppression.

## Deployment manifest and rollback

- Implementation source: company fork `nearfolk/paperclip`, verified source
  `94f4c8a5b56eb848d986bd952119dfc3b19d4caf`.
- Inspected default: `master`, `916c13501f80c7d1d659b89e4a06dc47366aa80f`.
- Observed runtime: version `0.3.1`, commit unavailable from the supported health
  API. Neither source SHA is certified as the deployed baseline.
- Dependency preparation: the retained source manifest already declares `svix`
  while its checked-in lockfile omits it. Local validation used a regenerated
  lockfile; repository policy reserves committed lockfile updates for CI, whose
  policy job regenerates it for downstream checks. That resolution includes
  `uuid@10.0.0`, flagged by dependency review as GHSA-w5hq-g745-h8pq. This change
  introduces no dependency manifest changes. CTO must resolve that inherited
  dependency risk in the integrated baseline; a passing diff-only dependency
  review does not certify the regenerated dependency graph.
- Migration: `0274_majestic_fenris.sql` plus its generated snapshot/journal.
  Four new empty tables and indexes; no historical data rewrite. Reconcile the
  ordinal with sibling migrations through the normal generator before integration.
- Rollout owner: CTO. Keep existing timer containment (`enabled=false`,
  `wakeOnDemand=true`) while selecting the integrated source, validating schema
  compatibility and completing exact-head independent QA and CI. Preserve the
  complete runtime configuration when enabling `skipTimerWhenNoActionableWork`.
- Apply migrations only through the supported deployment/migration path after
  production holds permit it. This implementation authorizes no restart.
- After authorized deployment, verify `/api/health` provenance, the progress
  endpoint, blocked-queue zero calls and all four resume paths. Re-enable timers
  only for an explicitly scoped agent cohort after that acceptance.
- Redundant full-board timer sweeps hit the same deterministic gate; unchanged
  blocked queues never enter their prompts. Non-LLM health checks, assignment,
  dependency-ready events and recovery scheduling remain independently enabled.
- Rollback behavior: keep timers disabled, set the policy false through supported
  agent configuration if needed, and redeploy the prior certified binary through
  the authorized release path. Preserve all four tables for audit and recovery.
  No destructive rollback SQL is required. A later intentional schema removal is
  a separate migration after no running binary uses these tables.

The CTO's remaining action is to choose and certify the integrated baseline,
combine the reliability and scheduler changes, obtain exact-head gates, and
execute the held deployment when authorized. A successful local test is not
production acceptance.
