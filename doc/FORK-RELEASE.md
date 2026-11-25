# Protected activation in the company fork

This command applies only to `nearfolk/paperclip`, targeting `master`. It adapts
the company product's ticket-authority guard without changing the product repo.
It does not install branch protection. `master` is currently unprotected; the
operator must use this command. GitHub approval is neither requested nor used.
Only a distinct authenticated CTO may submit the merge. Implementation and QA
runs must not merge or deploy.

## Explicit gate mapping

The fork has `.github/workflows/pr.yml`, not `ci.yml`. Its mapping is versioned
in `scripts/fork-gate-policy.mjs`. A SHA-256 of the complete workflow prevents a
new/changed/removed job from silently weakening the inventory. Mapping changes
need independent review. The `policy` job runs the scanner and guard tests.

| Required lane | Required successful jobs |
| --- | --- |
| Policy | `policy` |
| Typecheck | `Typecheck + Release Registry` |
| General tests | server 1/3, 2/3, 3/3; workspaces-a; workspaces-b |
| Build and aggregate | `Build`, `verify` |
| Serialized tests | `Verify serialized server suites (1/4)` through `(4/4)` |
| Release rehearsal | `Canary Dry Run` |
| End-to-end | `e2e shard (1/2)`, `(2/2)`, and aggregate `e2e` |

All 17 jobs must be present and successful in the latest exact-head ordinary PR
run and its current attempt. Aggregate success alone is insufficient. Jobs from
other workflows cannot satisfy these gates. API errors, missing pages,
duplicate jobs, skipped required jobs, pending runs, and failed checks block.
The conditional `Storybook visual regression` skip is allowed only when its
opt-in label is absent; a failed or requested visual run is not waived.

The fork has no `branch-freshness` context. The replacement predicate is
explicit: resolve current remote `master` to its full SHA, compare that immutable
SHA to the expected candidate, require matching comparison base and
`behind_by: 0`, then re-read `master` immediately before submission. The QA
verdict must accept this mapping by its digest. Absence of `branch-freshness`
is not reported as success. Any present failed status also blocks. GitHub's
expected-head merge predicate prevents a head race. GitHub does not offer an
atomic expected-base predicate on this merge operation; the last master check
minimizes that window but is not server-enforced branch protection.

## Bounded authentication bootstrap

Only PR #7, against master
`916c13501f80c7d1d659b89e4a06dc47366aa80f`, can use `bootstrap: true`.
The guard verifies the old base review workflow's exact SHA-256. The latest
candidate-head `pull_request_target` run must fail only at
`Generate commitperclip token`, and its log must contain
`ERROR: COMMITPERCLIP_KEY env var not set.` Checkout, Dependency Review and Node
setup must have succeeded. This permits only that inherited review-job failure
and the absent native security result it causes. It does not waive ordinary CI,
independent security review, independent QA, original FAIL retraction, authority
history, the operator handoff, or the five-minute interval.

The original failed candidate is
`ee560a3b4959b762f2294dd4c679b907760b8879`. Its original review ticket must be
included in `failureHistoryTickets`. The reviewer who authored each FAIL must
explicitly retract it, citing the comment ID and the new exact head, before the
qualifying PASS. This applies across head changes and ticket boundaries. A PASS
from another reviewer cannot clear that FAIL. The evidence attachment and
original verdict remain part of the review record.

Failure history uses the same verdict classifier as the authority evaluator,
including line-leading `FAIL`, `changes requested`, and `Security verdict: FAIL`.
Include every completed review ticket with an outstanding failure in the history
inventory, not just the first review. Each failure needs its original author's
explicit retraction naming that comment and the new candidate.

After activation, the exception cannot apply because master has changed. New
PR events must exercise the updated trusted-base workflow. Historical reruns
cannot prove activation. Normal mode requires the review workflow to succeed
and a completed exact-head `security-review` result from `github-actions`.
Neutral scanner findings still require an explicit independent security PASS.
This document and its tests are implementation evidence, not an activation claim.

## Ticket lifecycle and reviewer handoff

A review-deliverable child finishes when it posts its verdict, including FAIL.
It must not be reused as a completed merge gate. On PASS, the reviewer creates
a separate **protected activation gate** child, initially assigned to that
reviewer, with the contract below. The reviewer copies any needed authenticated
retraction onto that gate, posts its own exact-head QA/security PASS there, and
reassigns that gate to the named CTO in `in_review`. The reviewer records the
activation-gate link on the review-deliverable child and marks the review child
done. This gives the parent a completion wake while keeping the operator gate
open. On FAIL, finish the review child with findings; create no PASS gate.

The guard requires an actual reviewer-authored assignment history entry after
PASS. A link, copied comment attributed to someone else, closed review child,
or comment without assignment cannot substitute for the handoff. Inspect both
QA seats' actionable loads when assigning review. For this remediation, the
original FAIL author is the required reviewer because only that seat can
retract its own finding.

The protected gate description contains exactly one JSON block:

```fork-release-contract
{
  "version": 1,
  "repository": "nearfolk/paperclip",
  "pr": 7,
  "head": "<full candidate SHA>",
  "mappingDigest": "<mapping SHA-256>",
  "reviewerId": "<selected independent QA agent ID>",
  "operatorId": "<named CTO agent ID>",
  "implementationTicket": "<implementation issue ID>",
  "requiredVerdicts": [],
  "failureHistoryTickets": ["<original FAIL issue ID>"],
  "bootstrap": true
}
```

List every other required team verdict as
`{"ticket":"<issue ID>","reviewerId":"<required independent actor ID>"}`.
Document why product/design/editorial reviews do not apply to this CI-only
change. The security review is mandatory and can be delivered by the designated
independent QA seat. Obtain the mapping digest with:

```sh
node --input-type=module -e "import { MAPPING_DIGEST } from './scripts/fork-gate-policy.mjs'; console.log(MAPPING_DIGEST)"
```

Use separate retraction and PASS comments. Example retraction:
`I retract FAIL at comment <original comment ID> for corrected head <new SHA>.`
Post each retraction as this complete standalone affirmative sentence, ending in
a period. The guard extracts the exact cited comment ID and head from that
sentence. Negated, prospective, conditional, quoted, instructional, or edited
receipts cannot clear a failure. A retraction must precede the qualifying PASS;
equal timestamps do not prove that ordering. Put supporting discussion in a
separate comment.
The qualifying PASS contains these explicit receipts, with real values:

```text
PASS
Head <new exact 40-character SHA>
Security verdict: PASS
Fork gate mapping: <mapping SHA-256>
Bootstrap exception: PR #7 base 916c13501f80c7d1d659b89e4a06dc47366aa80f; missing COMMITPERCLIP_KEY only.
No other team verdicts are required.
```

Omit the bootstrap line in normal mode. Use the last line only if the required
team inventory is empty; otherwise supply all required tickets. A changed head
requires fresh independent review, including the gate mapping and all security
findings. Every qualifying verdict/clearance starts a five-full-minute interval;
4:59 fails. A hold blocks immediately. Silence is never clearance.

Primary QA and required team PASS comments must be immutable: an `updatedAt`
different from `createdAt` rejects the receipt. Post a new verdict comment after
an edit; its creation time restarts the full interval. Factual statements that
previous-head test results cannot approve the current head are stale-evidence
warnings, not release denials. Actual denials, adjacent restrictions, holds and
ambiguous authority still fail closed.
Direct merge, release and deployment prohibitions also block, whether posted on
the gate or an ancestor; a missing exact head does not default to permission.
Reviewer-only assignment instructions remain scoped to the reviewer when they
explicitly hand protected activation to the distinct CTO. They cannot mask an
adjacent prohibition directed at that operator or candidate.

Required-review tickets contribute their own descriptions, authors, timestamps
and issue IDs as well as their comments and ancestor histories. A team PASS does
not erase a description-level denial or hold. Edited restrictions take effect at
their update time. Each denial clause must bind its own head; a contextual SHA in
another sentence cannot hide a current or ambiguous prohibition. Multiple heads
and unscoped prohibitions fail closed. Negative authorization and qualified
prohibitions, such as “Merge is not authorized” and “Do not under any circumstances
merge,” are denials.

Hold clearances use the same strict receipt parser in every guard path. Post a
new standalone comment, with a period, using one of these forms:

```text
I clear hold at comment <hold comment ID> for exact head <SHA>.
I clear hold at description <issue ID> for exact head <SHA>.
I clear hold at comment <hold comment ID> solely for protected merge and normal dormant deployment at exact head <SHA>.
```

Only the hold author or an authenticated CEO/board actor may clear the cited
source. An unscoped authority hold requires the bounded protected-merge form.
Each hold needs its own receipt; substring ID matches do not qualify. The receipt
must follow the latest hold timestamp and have equal creation/update timestamps
when an update timestamp exists. Future, conditional, negated, quoted,
instructional, edited, or misbound comments cannot clear it. New replacement
receipts restart five full minutes. This intentionally rejects legacy narrative
clearances such as “Release hold cleared”; historical product-guard fixtures
using those forms must be reissued in the fork receipt format. The product
repository's release controls are unchanged.

Ticket and ancestor descriptions/comments, original review histories,
assignment activity, required verdicts, and operator identity are re-fetched.
Unavailable or ambiguous authority blocks. Routine release needs no additional
board approval; an explicit authoritative denial or hold still governs.

The CTO runs from the independently reviewed checkout at the exact candidate:

```sh
pnpm verify:pr-release --pr 7 --qa-ticket <protected gate ID> --head <full SHA>
pnpm merge:pr --pr 7 --qa-ticket <protected gate ID> --head <full SHA>
```

The first command is read-only. The second discards its preflight evidence,
re-fetches all gates, quotes the reviewer verdict in a PR comment, re-fetches
again, checks master once more, and submits an admin squash merge with
`--match-head-commit`. No raw merge, fabricated GitHub approval, inherited
missing-key rerun, or credential procurement is part of this path. Record the
PASS/merge timestamps and actual merge result on the protected gate before
closing it. Activation and downstream deployed acceptance belong to the parent
operator task, which remains open until that work is independently established.

## Immutable scanner inputs

Both quality and security runners require event head/base SHAs. They validate
current PR metadata, fetch those exact commits into a temporary bare repository,
compute the complete merge-base-to-head diff, and validate metadata again before
reporting. Candidate code is never checked out or executed. External diff
programs/textconv and Git replacement objects are disabled. Content APIs use
immutable refs. Missing history, ambiguous merge bases, incomplete output,
resource bounds, fetch errors and malformed manifests all fail. Large scans may
need a separately reviewed resource-bound change; they never silently truncate.

New manifests may have a base 404 only when the immutable diff marks them added.
Their dependencies are still reported. Authentication, rate-limit, transport,
timeout, malformed content, existing-base 404 and candidate 404 errors fail the
quality job. Findings stay informational. Check-mode reports expose only fixed
categories and counts, never matching text or paths.

### Standalone release authority receipts

An existing executive denial scoped to the candidate can only be restored by a
completed, standalone affirmative receipt from the required authority, after the
QA PASS and the denial. For example (replace the placeholders):

```text
I authorize merge at exact head <40-character SHA>.
I authorize merge at exact head <40-character SHA>, clearing denial at comment <comment-id>.
```

An explicit source binding must match the denial's comment ID or use
`description <issue-id>` for an issue description. The receipt must be immutable;
a fresh qualifying receipt restarts five full minutes. Conditional, negative,
quoted, instructional, edited, wrong-head or wrong-source text is not authority.
A generic authorization cannot clear an unscoped hold, an ambiguous denial, or
an unavailable actor's denial; those require the bounded source-specific receipt
and actor rules above. This does not add a routine executive approval gate.

Denial splitting uses the same recognized grammar as denial classification,
including contractions, curly apostrophes and qualified prohibitions. Scope is
local to each directive. A previous head or a statement that no hold applies to
that head cannot erase an adjacent current hold or unscoped restriction.
Conversational `hold, do not approve yet` remains a single directive. Descriptive
phrases such as “authority and hold evaluation” do not create hold directives.
The inherited conversational-hold regression was an unsafe acceptance, not a
legacy-receipt compatibility exception; it is now required to block release.

The narrow reviewer-only lifecycle assignment may be recorded by a nonexecutive
in a comment when an active QA checkout prevents description edits. It retains
the explicit completed-review/separate-CTO-activation boundary. Only its exact
reviewer instruction is exempt; adjacent live denials and executive directives
remain effective. The same assignment cannot confer release authority.

Every source-bound hold clearance is resolved against an actual pending denial
before it can restore authority. This includes an executive denial with explicit
head scope. A nonexistent source, an unrelated source, or a receipt for a different
description cannot act as generic authorization. Each pending denial is retained
until a valid receipt clears it; clearing one cannot erase another. Receipts may
clear sources in either order, with the last clearance starting the full interval.

Markdown backticks alone do not make an instruction diagnostic. Only a locally
introduced example or a quoted input with an explicit observed parser result is
excluded from denial classification. A diagnostic example cannot hide another
quoted live directive on the same line. Executive directives are never subject
to this diagnostic exception. The complete nonexecutive sentence “Independently
review this narrow exception; it grants no release authority.” describes the
exception's limits; a standalone or adjacent release denial remains binding.

A result-like suffix such as “is accepted” or “is interpreted” never establishes
that a quotation is diagnostic. The quoted input must have an explicit local
example/input introduction or a bounded reported reproduction. Only a syntactic
list of quoted inputs can inherit its first input's introduction; intervening
prose ends that provenance. Diagnostic words elsewhere on the line do not grant
an exemption to a release restriction or binding decision.

Every diagnostic alternative now consumes the complete input introduction and
remaining source text, including punctuation, code spans and line breaks. A
partial result or a reproduction-location sentence cannot exempt a binding or
ambiguous quotation. The observed result, explicit assertion, receipt sequence,
linked factual explanation and input-list forms all obey that same boundary.
Put new diagnostic assertions in standalone comments using those complete forms.

Eight original QA reports predate that bounded grammar and contain narrative
reproductions. Their compatibility inventory in `fork-ticket-authority.mjs`
binds each original comment ID, original author and SHA-256 of its entire body;
`fixtures/fork-diagnostic-reports.json` retains the complete auditable originals.
Only quoted reproduction inputs are excluded, only for a matching unedited
nonexecutive comment. No matching paragraph, changed identity, description,
appended sentence, or edited timestamp qualifies. This inventory neither retracts
a FAIL nor clears a hold: all eight original-author receipts, fresh independent
PASS, operator assignment and five-minute interval are still required. The
inventory and stricter grammar require independent review at the new head.
