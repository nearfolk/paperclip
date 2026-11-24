import { isHold, hasHoldForHead } from './fork-ticket-authority.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { evaluateForkGithub, evaluateForkTickets, parseContract, digest, MAPPING_DIGEST, PR_WORKFLOW_DIGEST, BOOTSTRAP_BASE, ORIGINAL_FAILED_HEAD, REQUIRED_JOBS, REPOSITORY } from './fork-gate-policy.mjs';
const head = 'a'.repeat(40), reviewer = 'qa', operator = 'cto';
const at = '2026-11-24T12:00:00.000Z';
const contract = () => ({ version: 1, repository: REPOSITORY, pr: 7, head, mappingDigest: MAPPING_DIGEST, reviewerId: reviewer, operatorId: operator, implementationTicket: 'implementation', requiredVerdicts: [], failureHistoryTickets: ['original'], bootstrap: true });
const comment = (id, body, createdAt = at, authorAgentId = reviewer) => ({ id, body, createdAt, authorAgentId });
function tickets() {
  const c = contract();
  const pass = comment('pass', `PASS\nHead ${head}\nSecurity verdict: PASS\nFork gate mapping: ${MAPPING_DIGEST}\nBootstrap exception: PR #7 base ${BOOTSTRAP_BASE}; missing COMMITPERCLIP_KEY only.\nNo other team verdicts are required.`);
  // The base mentioned in the required bootstrap receipt is not a second
  // candidate head; the policy checks candidate scope separately below.
  return {
    contract: c, identity: { id: operator, role: 'cto' }, actors: [{ id: operator, role: 'cto' }, { id: 'ceo', role: 'ceo' }],
    snapshot: { issue: { id: 'gate', status: 'in_review', assigneeAgentId: operator, createdAt: '2026-11-24T11:00:00Z' }, comments: [comment('retract', `I retract FAIL at comment original-fail for corrected head ${head}.`, '2026-11-24T11:59:00Z'), pass], authorityScope: [], interactions: [], activity: [{ action: 'issue.updated', actorId: reviewer, createdAt: '2026-11-24T12:00:30Z', details: { assigneeAgentId: operator, _previous: { assigneeAgentId: reviewer } } }] },
    histories: [{ issue: { id: 'original', description: '', createdAt: '2026-11-24T10:00:00Z' }, comments: [comment('original-fail', `FAIL\nHead ${ORIGINAL_FAILED_HEAD}`, '2026-11-24T11:00:00Z')], authorityScope: [] }],
    required: [], implementation: { issue: { assigneeAgentId: 'author', description: `Head ${head}` }, comments: [] }, nowMs: Date.parse(at) + 300_000,
  };
}
function github() {
  const c = contract();
  const reviewRun = { id: 2, path: '.github/workflows/commitperclip-review.yml', event: 'pull_request_target', head_sha: head, status: 'completed', conclusion: 'failure' };
  return {
    contract: c, pr: { state: 'OPEN', isDraft: false, headRefOid: head, baseRefName: 'master', baseRefOid: BOOTSTRAP_BASE, labels: [] }, master: BOOTSTRAP_BASE,
    compare: { base_commit: { sha: BOOTSTRAP_BASE }, behind_by: 0, status: 'ahead' }, workflow: readFileSync(new URL('../.github/workflows/pr.yml', import.meta.url), 'utf8'),
    run: { id: 1, path: '.github/workflows/pr.yml', event: 'pull_request', head_sha: head, status: 'completed', conclusion: 'success' },
    jobs: REQUIRED_JOBS.map(name => ({ name, run_id: 1, head_sha: head, status: 'completed', conclusion: 'success' })),
    reviewRun, reviewJobs: [{ name: 'review', run_id: 2, head_sha: head, conclusion: 'failure', steps: [
      ...['Checkout base branch (never PR code)', 'Dependency Review', 'Set up Node'].map(name => ({ name, conclusion: 'success' })),
      { name: 'Generate commitperclip token', conclusion: 'failure' },
    ] }],
    reviewLog: 'ERROR: COMMITPERCLIP_KEY env var not set.',
    oldReview: execFileSync('git', ['show', `${BOOTSTRAP_BASE}:.github/workflows/commitperclip-review.yml`], { encoding: 'utf8' }), checks: [], reviews: [],
  };
}
test('workflow mapping includes the current immutable file and all 17 jobs', () => {
  assert.equal(digest(github().workflow), PR_WORKFLOW_DIGEST); assert.equal(REQUIRED_JOBS.length, 17);
});
test('bounded old-base bootstrap accepts only complete ordinary CI', () => assert.equal(evaluateForkGithub(github()).bootstrap, true));
for (const [name, mutate] of [
  ['changed head', x => x.pr.headRefOid = 'b'.repeat(40)],
  ['changed master', x => x.master = 'c'.repeat(40)],
  ['closed PR', x => x.pr.state = 'MERGED'], ['draft', x => x.pr.isDraft = true],
  ['behind master', x => x.compare.behind_by = 1], ['missing compare', x => x.compare = {}],
  ['wrong comparison base', x => x.compare.base_commit.sha = head],
  ['changed workflow', x => x.workflow += '\n# changed'],
  ['wrong workflow provenance', x => x.run.path = '.github/workflows/other.yml'],
  ['old CI head', x => x.run.head_sha = BOOTSTRAP_BASE], ['CI pending', x => x.run.status = 'in_progress'],
  ['missing shard', x => x.jobs.pop()], ['aggregate only', x => x.jobs = x.jobs.filter(j => j.name === 'verify')],
  ['skipped shard', x => x.jobs[3].conclusion = 'skipped'], ['failed shard', x => x.jobs[3].conclusion = 'failure'],
  ['duplicate shard', x => x.jobs[3] = x.jobs[2]], ['wrong job run', x => x.jobs[2].run_id = 99],
  ['bootstrap wrong PR', x => x.contract.pr = 8], ['wrong old workflow', x => x.oldReview += '\n'],
  ['unrelated review failure', x => x.reviewJobs[0].steps[3].name = 'Dependency Review'],
  ['bootstrap missing failure log', x => x.reviewLog = 'failed'],
  ['review pending', x => x.reviewRun.status = 'in_progress'],
  ['review older head', x => x.reviewRun.head_sha = BOOTSTRAP_BASE],
  ['additional failure', x => x.checks.push({ name: 'unrelated', head_sha: head, status: 'completed', conclusion: 'failure' })],
  ['changes requested', x => x.reviews.push({ user: { login: 'reviewer' }, submitted_at: at, state: 'CHANGES_REQUESTED' })],
  ['normal path missing security', x => { x.contract.bootstrap = false; x.reviewRun.conclusion = 'success'; x.reviewJobs[0].conclusion = 'success'; }],
]) test(`fork GitHub guard rejects ${name}`, () => { const x = github(); mutate(x); assert.throws(() => evaluateForkGithub(x)); });

test('contract must name mapping, reviewers, implementation and original history', () => {
  const c = contract(); const issue = { description: '```fork-release-contract\n' + JSON.stringify(c) + '\n```' };
  assert.deepEqual(parseContract(issue, head, 7), c);
  for (const field of ['mappingDigest', 'operatorId', 'implementationTicket', 'failureHistoryTickets']) {
    const bad = structuredClone(c); delete bad[field];
    assert.throws(() => parseContract({ description: '```fork-release-contract\n' + JSON.stringify(bad) + '\n```' }, head, 7));
  }
});
test('QA gate permits exactly five minutes with original author retraction', () => assert.equal(evaluateForkTickets(tickets()).reviewerId, reviewer));
for (const format of ['FAIL', '## FAIL', 'changes requested', 'Security verdict: FAIL']) {
  for (const failedHead of [head, 'c'.repeat(40)]) test(`${format} requires its author's retraction across tickets at ${failedHead === head ? 'current' : 'older'} head`, () => {
    const x = tickets();
    x.histories[0].comments.push(comment('additional-failure', `${format}\nHead ${failedHead}`, '2026-11-24T11:30:00Z', 'security-reviewer'));
    assert.throws(() => evaluateForkTickets(x), /FAIL/);
    const retraction = comment('additional-retraction', `I retract FAIL at comment additional-failure for corrected head ${head}.`, '2026-11-24T11:59:30Z', reviewer);
    x.snapshot.comments.push(retraction);
    assert.throws(() => evaluateForkTickets(x), /FAIL/);
    retraction.authorAgentId = 'security-reviewer';
    retraction.body = `I retract FAIL at comment additional-failure for corrected head ${'d'.repeat(40)}.`;
    assert.throws(() => evaluateForkTickets(x), /FAIL/);
    retraction.body = `I retract FAIL at comment additional-failure for corrected head ${head}.`;
    assert.doesNotThrow(() => evaluateForkTickets(x));
  });
}
function requiredTeamTickets() {
  const x = tickets();
  x.contract.requiredVerdicts = [{ ticket: 'security', reviewerId: 'security-reviewer' }];
  x.required = [{ issue: { id: 'security' }, comments: [comment('team-pass', `Security verdict: PASS\nHead ${head}`, '2026-11-24T11:00:00Z', 'security-reviewer')], authorityScope: [] }];
  return x;
}
test('a failure report discussing required retraction remains an outstanding FAIL', () => {
  const x = tickets();
  x.histories[0].comments.push(comment('followup-failure', `FAIL\nHead ${'c'.repeat(40)}\nOriginal FAIL retraction remains required.`, '2026-11-24T11:30:00Z'));
  assert.throws(() => evaluateForkTickets(x), /Unretracted FAIL: followup-failure/);
  x.snapshot.comments.push(comment('followup-retraction', `I retract FAIL at comment followup-failure for corrected head ${head}.`, '2026-11-24T11:59:30Z'));
  assert.doesNotThrow(() => evaluateForkTickets(x));
});
for (const receipt of [
  'I do not retract FAIL at comment original-fail for corrected head HEAD.',
  'I never retract FAIL at comment original-fail for corrected head HEAD.',
  'I will retract FAIL at comment original-fail for corrected head HEAD after remediation is validated.',
  'A future retraction of FAIL at comment original-fail for corrected head HEAD is required.',
  'Please retract FAIL at comment original-fail for corrected head HEAD.',
  'I retract FAIL at comment original-fail for corrected head HEAD if validation passes.',
  'I retract FAIL at comment original-fail for corrected head HEAD unless new findings appear.',
  'I retract FAIL at comment original-fail for corrected head HEAD. This is conditional.',
  'Example: I retract FAIL at comment original-fail for corrected head HEAD.',
  'I retract FAIL at comment original-fail for corrected head HEAD.\nI do not retract that finding.',
  'I retract FAIL at comment original-fail-suffix for corrected head HEAD.',
  'I retract FAIL at comment other-fail for corrected head HEAD. Original: original-fail.',
]) test(`only a completed unqualified receipt clears FAIL: ${receipt}`, () => {
  const x = tickets(); x.snapshot.comments[0].body = receipt.replace('HEAD', head);
  assert.throws(() => evaluateForkTickets(x), /FAIL/);
});
test('retraction edits and same-time retraction/PASS cannot qualify', () => {
  const x = tickets(); x.snapshot.comments[0].updatedAt = at;
  assert.throws(() => evaluateForkTickets(x), /FAIL/);
  delete x.snapshot.comments[0].updatedAt;
  x.snapshot.comments[0].createdAt = at;
  assert.throws(() => evaluateForkTickets(x), /FAIL/);
});
for (const prohibition of ['Do not merge', 'Must not merge', 'Never merge', 'Do not release', 'Do not deploy', 'Merge is prohibited']) {
  for (const scope of ['gate', 'ancestor', 'description']) test(`direct prohibition blocks ${scope}: ${prohibition}`, () => {
    const x = tickets();
    const denial = comment('direct-denial', `${prohibition} PR #7 at exact head ${head}.`, '2026-11-24T12:01:00Z', 'ceo');
    if (scope === 'description') x.snapshot.authorityScope.push({ ...denial, sourceKind: 'issue_description', sourceIssueId: 'ancestor' });
    else (scope === 'gate' ? x.snapshot.comments : x.snapshot.authorityScope).push(denial);
    assert.throws(() => evaluateForkTickets(x), /denied|denial|authority|hold/i);
  });
}
test('direct prohibition with absent or unknown authority fails closed; older head stays scoped', () => {
  const x = tickets();
  const denial = comment('direct-denial', 'Do not merge.', '2026-11-24T12:01:00Z', 'ceo');
  x.snapshot.authorityScope.push(denial);
  assert.throws(() => evaluateForkTickets(x), /ambiguous/);
  denial.body = `Do not merge PR #7 at exact head ${head}.`;
  denial.authorAgentId = 'unknown';
  assert.throws(() => evaluateForkTickets(x), /authority is unavailable/);
  denial.authorAgentId = 'ceo'; denial.body = `Do not merge PR #7 at exact head ${'c'.repeat(40)}.`;
  assert.doesNotThrow(() => evaluateForkTickets(x));
});
test('edited required PASS cannot inherit the old creation timestamp', () => {
  const x = requiredTeamTickets();
  x.required[0].comments[0].updatedAt = '2026-11-24T12:04:59Z';
  assert.throws(() => evaluateForkTickets(x), /Edited required PASS/);
  // A fresh immutable replacement starts a full new interval.
  x.required[0].comments.push(comment('new-team-pass', `PASS ${head}`, '2026-11-24T12:04:59Z', 'security-reviewer'));
  x.nowMs = Date.parse('2026-11-24T12:09:58Z');
  assert.throws(() => evaluateForkTickets(x), /Five full minutes/);
  x.nowMs += 1000;
  assert.equal(evaluateForkTickets(x).eligibleAt, '2026-11-24T12:09:59.000Z');
});
test('unchanged required PASS timestamp is accepted; malformed update fails closed', () => {
  const x = requiredTeamTickets();
  x.required[0].comments[0].updatedAt = x.required[0].comments[0].createdAt;
  assert.doesNotThrow(() => evaluateForkTickets(x));
  x.required[0].comments[0].updatedAt = 'invalid';
  assert.throws(() => evaluateForkTickets(x), /timestamp/);
});
function realReviewLifecycle() {
  // Saved authoritative review description from the independent QA evidence.
  // All verdicts/assignments below are offline fixtures, never API mutations.
  const issue = JSON.parse(readFileSync(new URL('./fixtures/fork-review-liv-11645.json', import.meta.url), 'utf8'));
  const candidate = 'c64e1cf3530a195940a7b19a3059be74a7eb519c';
  const x = JSON.parse(JSON.stringify(tickets()).replaceAll(head, candidate));
  x.contract.failureHistoryTickets.push(issue.id);
  x.histories.push({ issue, comments: [comment('second-failure', `Security verdict: FAIL\nHead ${'c64e1cf3530a195940a7b19a3059be74a7eb519c'}`, '2026-11-24T11:30:00Z')], authorityScope: [] });
  x.snapshot.comments.push(comment('second-retraction', `I retract FAIL at comment second-failure for corrected head ${candidate}.`, '2026-11-24T11:59:30Z'));
  return x;
}
test('real review description permits a fresh separate reviewer-to-CTO gate', () => {
  const x = realReviewLifecycle();
  assert.doesNotThrow(() => evaluateForkTickets(x));
  x.snapshot.issue.status = 'done';
  assert.throws(() => evaluateForkTickets(x));
});
for (const denial of [
  'Do not approve this head.',
  'Do not merge this head.',
  'Must not release this head.',
  'I cannot authorize release.',
  'HOLD: freeze the release.',
  "Current head's results do not approve this head.",
  "Previous head's results do not approve this head until the board clears it.",
]) test(`stale-evidence exception preserves actual or ambiguous restriction: ${denial}`, () => {
  const x = realReviewLifecycle();
  x.histories[1].issue.description += `\n${denial}`;
  assert.throws(() => evaluateForkTickets(x), /denial|hold|authority/i);
});
test('stale-evidence exception preserves an adjacent same-sentence denial', () => {
  const x = realReviewLifecycle();
  x.histories[1].issue.description += "\nPrevious head's results do not approve this head. Do not approve this head.";
  assert.throws(() => evaluateForkTickets(x), /denial|authority/i);
});
for (const [name, mutate] of [
  ['4:59', x => x.nowMs--], ['same author QA', x => x.implementation.issue.assigneeAgentId = reviewer],
  ['wrong operator', x => x.identity.id = 'other'], ['non-CTO operator', x => x.identity.role = 'engineer'],
  ['completed review-deliverable used as gate', x => x.snapshot.issue.status = 'done'],
  ['no handoff', x => x.snapshot.activity = []], ['operator fabricated handoff', x => x.snapshot.activity[0].actorId = operator],
  ['head changed', x => x.contract.head = 'b'.repeat(40)], ['missing history', x => x.histories = []],
  ['no original FAIL', x => x.histories[0].comments = []],
  ['unretracted old FAIL', x => x.snapshot.comments.shift()],
  ['other seat retraction', x => x.snapshot.comments[0].authorAgentId = 'other'],
  ['retraction after PASS', x => x.snapshot.comments[0].createdAt = '2026-11-24T12:01:00Z'],
  ['missing security verdict', x => x.snapshot.comments[1].body = x.snapshot.comments[1].body.replace('Security verdict: PASS', '')],
  ['missing mapping acceptance', x => x.snapshot.comments[1].body = x.snapshot.comments[1].body.replace(MAPPING_DIGEST, 'unknown')],
  ['missing bootstrap acceptance', x => x.snapshot.comments[1].body = x.snapshot.comments[1].body.replace('Bootstrap exception:', 'Unknown exception:')],
  ['new QA FAIL', x => x.snapshot.comments.push(comment('new-fail', `FAIL ${head}`, '2026-11-24T12:01:00Z'))],
  ['ancestor hold', x => x.snapshot.authorityScope.push(comment('ancestor-hold', `HOLD ${head}`, '2026-11-24T12:01:00Z', 'ceo'))],
  ['ambiguous ancestor denial', x => x.snapshot.authorityScope.push(comment('denial', 'Do not approve the release.', '2026-11-24T12:01:00Z', 'ceo'))],
  ['required team evidence omitted', x => x.contract.requiredVerdicts.push({ ticket: 'security', reviewerId: 'security' })],
]) test(`fork ticket guard rejects ${name}`, () => { const x = tickets(); mutate(x); assert.throws(() => evaluateForkTickets(x)); });
test('clearance restarts the full five minutes', () => {
  const x = tickets();
  x.snapshot.comments.push(comment('hold', `HOLD ${head}`, '2026-11-24T12:01:00Z', 'ceo'));
  x.snapshot.comments.push(comment('clear', `I clear the earlier HOLD at comment hold solely for protected merge at exact head ${head}.`, '2026-11-24T12:02:00Z', 'ceo'));
  assert.throws(() => evaluateForkTickets(x));
  x.nowMs = Date.parse('2026-11-24T12:07:00Z');
  assert.equal(evaluateForkTickets(x).eligibleAt, '2026-11-24T12:07:00.000Z');
});
test('editing an old PASS cannot backdate the five-minute interval', () => {
  const x = tickets(); x.snapshot.comments[1].updatedAt = '2026-11-24T12:04:00Z';
  assert.throws(() => evaluateForkTickets(x), /Edited PASS/);
});
test('missing authoritative ancestor history fails closed', () => {
  const x = tickets(); delete x.snapshot.authorityScope;
  assert.throws(() => evaluateForkTickets(x));
});
test('a required security verdict from the wrong actor does not qualify', () => {
  const x = tickets();
  x.contract.requiredVerdicts = [{ ticket: 'security', reviewerId: 'security-reviewer' }];
  x.required = [{ issue: { id: 'security' }, comments: [comment('security-pass', `PASS ${head}`, at, 'author')], authorityScope: [] }];
  assert.throws(() => evaluateForkTickets(x), /author or head mismatch/);
});
test('normal mode requires completed same-head repository security check', () => {
  const x = github(); x.contract.bootstrap = false;
  x.reviewRun.conclusion = 'success'; x.reviewJobs[0].conclusion = 'success';
  x.checks = [{ name: 'security-review', head_sha: head, app: { slug: 'github-actions' }, status: 'completed', conclusion: 'neutral' }];
  assert.equal(evaluateForkGithub(x).bootstrap, false);
  x.checks[0].head_sha = ORIGINAL_FAILED_HEAD;
  assert.throws(() => evaluateForkGithub(x), /security scan/);
});

// QA authority-boundary regressions. Keep valid controls beside rejection cases.
for (const scope of ['gate', 'ancestor', 'required description']) {
  for (const body of [
    `Merge is not authorized for PR #7 at exact head ${head}.`,
    `Deployment is not authorized for exact head ${head}.`,
    `Do not under any circumstances merge PR #7 at exact head ${head}.`,
    `Do not, under any circumstances, merge PR #7 at exact head ${head}.`,
    `Do not automatically merge PR #7 at exact head ${head}.`,
    `Merge is not yet authorized for exact head ${head}.`,
    `Previous candidate was ${'c'.repeat(40)}. Do not merge the current head of PR #7.`,
    `Previous candidate was ${'c'.repeat(40)}; Do not merge.`,
    `Previous candidate was ${'c'.repeat(40)}, do not merge the current head.`,
    `Previous candidate was at exact head ${'c'.repeat(40)}, do not merge.`,
    `Do not merge at exact head ${'c'.repeat(40)} and deployment is not authorized.`,
    `Do not merge for exact head ${'c'.repeat(40)} and do not merge the current head.`,
    `Do not merge for exact head ${'c'.repeat(40)} or ${'d'.repeat(40)}.`,
    `Do not merge for exact head ${'c'.repeat(40)}. Do not merge for exact head ${head}.`,
  ]) test(`${scope} retains each current or ambiguous denial: ${body}`, () => {
    const x = scope === 'required description' ? requiredTeamTickets() : tickets();
    const denial = comment('denial', body, '2026-11-24T12:01:00Z', 'ceo');
    if (scope === 'required description') Object.assign(x.required[0].issue, {
      description: body, createdByAgentId: 'ceo', createdAt: denial.createdAt,
    });
    else (scope === 'gate' ? x.snapshot.comments : x.snapshot.authorityScope).push(denial);
    assert.throws(() => evaluateForkTickets(x), /denied|denial|authority/i);
  });
}
test('a single explicitly bound old-head denial does not govern this candidate', () => {
  const x = tickets();
  x.snapshot.authorityScope.push(comment('old-denial', `Do not merge PR #7 at exact head ${'c'.repeat(40)}.`, '2026-11-24T12:01:00Z', 'ceo'));
  assert.doesNotThrow(() => evaluateForkTickets(x));
});
for (const receipt of [
  'I will clear hold at comment hold for exact head HEAD after remediation.',
  'If remediation passes, I clear hold at comment hold for exact head HEAD.',
  'I have not cleared hold at comment hold for exact head HEAD.',
  'Please clear hold at comment hold for exact head HEAD.',
  '> I clear hold at comment hold for exact head HEAD.',
  'I clear hold at comment hold for exact head HEAD if validation passes.',
  'I clear hold at comment hold for exact head HEAD. This is conditional.',
  'I clear hold at comment hold-suffix for exact head HEAD.',
  'I clear hold at comment other for exact head HEAD. Original: hold.',
  'I clear hold at description hold for exact head HEAD.',
  `I clear hold at comment hold for exact head ${'c'.repeat(40)}.`,
]) test(`hold clearance rejects non-receipt or wrong binding: ${receipt}`, () => {
  const x = tickets();
  x.snapshot.comments.push(comment('hold', `HOLD ${head}`, '2026-11-24T12:01:00Z', operator),
    comment('clear', receipt.replace('HEAD', head), '2026-11-24T12:02:00Z', operator));
  x.nowMs = Date.parse('2026-11-24T12:10:00Z');
  assert.throws(() => evaluateForkTickets(x), /hold/i);
});
for (const holder of [operator, 'ceo']) test(`immutable ${holder} clearance restarts timing and rejects edits/wrong actors`, () => {
  const x = tickets();
  const clear = comment('clear', `I clear hold at comment hold for exact head ${head}.`, '2026-11-24T12:02:00Z', holder);
  x.snapshot.comments.push(comment('hold', `HOLD ${head}`, '2026-11-24T12:01:00Z', holder), clear);
  x.nowMs = Date.parse('2026-11-24T12:06:59Z');
  assert.throws(() => evaluateForkTickets(x), /minute/i);
  x.nowMs += 1000;
  assert.doesNotThrow(() => evaluateForkTickets(x));
  clear.authorAgentId = 'unrelated';
  assert.throws(() => evaluateForkTickets(x));
  clear.authorAgentId = holder; clear.updatedAt = '2026-11-24T12:06:59Z';
  assert.throws(() => evaluateForkTickets(x));
  const fresh = { ...clear, id: 'fresh', createdAt: clear.updatedAt };
  x.snapshot.comments.push(fresh);
  assert.throws(() => evaluateForkTickets(x), /minute/i);
  x.nowMs = Date.parse(fresh.createdAt) + 300_000;
  assert.doesNotThrow(() => evaluateForkTickets(x));
});
test('required ticket description holds preserve source identity and require a fresh bound clearance', () => {
  const x = requiredTeamTickets();
  Object.assign(x.required[0].issue, { description: `HOLD ${head}`, createdByAgentId: operator, createdAt: '2026-11-24T11:00:00Z', updatedAt: '2026-11-24T12:01:00Z' });
  assert.throws(() => evaluateForkTickets(x), /hold/i);
  const clearance = comment('clear', `I clear hold at description security for exact head ${head}.`, '2026-11-24T12:02:00Z', operator);
  x.snapshot.comments.push(clearance);
  x.nowMs = Date.parse(clearance.createdAt) + 299_000;
  assert.throws(() => evaluateForkTickets(x), /minute/i);
  x.nowMs += 1000;
  assert.doesNotThrow(() => evaluateForkTickets(x));
  x.required[0].issue.updatedAt = '2026-11-24T12:03:00Z';
  assert.throws(() => evaluateForkTickets(x), /hold/i);
});
test('each hold needs its own receipt even when another hold was cleared', () => {
  const x = tickets();
  x.snapshot.comments.push(comment('hold-1', `HOLD ${head}`, '2026-11-24T12:01:00Z', operator),
    comment('hold-2', `HOLD ${head}`, '2026-11-24T12:01:01Z', operator),
    comment('clear-2', `I clear hold at comment hold-2 for exact head ${head}.`, '2026-11-24T12:02:00Z', operator));
  x.nowMs = Date.parse('2026-11-24T12:10:00Z');
  assert.throws(() => evaluateForkTickets(x), /hold/i);
  x.snapshot.comments.push(comment('clear-1', `I clear hold at comment hold-1 for exact head ${head}.`, '2026-11-24T12:02:01Z', operator));
  assert.doesNotThrow(() => evaluateForkTickets(x));
});
test('a contextual older SHA cannot hide a current or unscoped hold', () => {
  const x = tickets();
  x.snapshot.authorityScope.push(comment('hold', `Previous head was ${'c'.repeat(40)}. HOLD current head.`, '2026-11-24T12:01:00Z', operator));
  assert.throws(() => evaluateForkTickets(x), /hold/i);
});

test('diagnostic placeholders do not mask adjacent live prohibitions', () => {
  const x = tickets();
  const diagnostic = comment('diagnostic', '- **P2 — reproduction.** The fixture `Previous candidate was <older SHA>. Do not merge current head.` previously passed.', '2026-11-24T12:01:00Z', reviewer);
  x.snapshot.authorityScope.push(diagnostic);
  assert.doesNotThrow(() => evaluateForkTickets(x));
  diagnostic.body += ` Do not merge at exact head ${head}.`;
  assert.throws(() => evaluateForkTickets(x), /denial|authority/i);
});

test('bounded immutable CEO receipt clears duplicate ancestor description snapshots', () => {
  const x = tickets();
  const hold = { body: 'HOLD', sourceKind: 'issue_description', sourceIssueId: 'ancestor', authorAgentId: 'ceo', createdAt: '2026-11-24T11:00:00Z' };
  x.snapshot.authorityScope.push(hold, { ...hold });
  const clear = comment('clear', `I clear hold at description ancestor solely for protected merge and normal dormant deployment at exact head ${head}.`, '2026-11-24T12:02:00Z', 'ceo');
  x.snapshot.comments.push(clear);
  x.nowMs = Date.parse(clear.createdAt) + 299_000;
  assert.throws(() => evaluateForkTickets(x), /minute/i);
  x.nowMs += 1000;
  assert.doesNotThrow(() => evaluateForkTickets(x));
  clear.body = clear.body.replace('ancestor', 'ancestor-suffix');
  assert.throws(() => evaluateForkTickets(x));
});

const oldBoundaryHead='c'.repeat(40);
for(const [label,fixture] of [['authority regression', tickets]]){
 const timed=x=>({ceo:x.actors.find(a=>a.role==='ceo').id,at:n=>new Date(x.nowMs-600000+n).toISOString()});
 test(`${label}: valid hypothetical handoff control`,()=>assert.doesNotThrow(()=>evaluateForkTickets(fixture())));
 for(const where of ['gate','ancestor','required description'])for(const body of [
  `Do not merge PR #7 at exact head ${oldBoundaryHead}, but don't merge this candidate either.`,
  `Do not merge PR #7 at exact head ${oldBoundaryHead} and mustn't merge this candidate.`,
  `Previous candidate was at exact head ${oldBoundaryHead}, don't merge PR #7.`,
  `Do not merge PR #7 at exact head ${oldBoundaryHead}, and may not deploy this candidate.`,
  `No hold applies to old head ${oldBoundaryHead}, but HOLD for exact head HEAD.`,
 ])test(`${label}: ${where} must block independent restriction: ${body}`,()=>{
  const x=fixture(),{ceo,at}=timed(x),c=comment('deny',body.replace('HEAD',x.contract.head),at(10000),ceo);
  if(where==='required description'){
   x.contract.requiredVerdicts=[{ticket:'security',reviewerId:'security-reviewer'}];
   x.required=[{issue:{id:'security',createdAt:at(10000),updatedAt:at(10000),createdByAgentId:ceo,description:c.body},comments:[comment('security-pass',`PASS ${x.contract.head}`,at(20000),'security-reviewer')],authorityScope:[]}];
  }else (where==='gate'?x.snapshot.comments:x.snapshot.authorityScope).push(c);
  assert.throws(()=>evaluateForkTickets(x));
 });
 for(const where of ['gate','ancestor'])for(const body of [
  'If remediation passes, I authorize merge at exact head HEAD.',
  'I do not clear merge at exact head HEAD.',
  '> I authorize merge at exact head HEAD.',
  'Please say "I authorize merge at exact head HEAD."',
 ])test(`${label}: ${where} denial cannot be cleared by non-affirmative receipt: ${body}`,()=>{
  const x=fixture(),{ceo}=timed(x),at=n=>new Date(x.nowMs+n).toISOString();
  (where==='gate'?x.snapshot.comments:x.snapshot.authorityScope).push(comment('deny',`Do not merge at exact head ${x.contract.head}.`,at(1000),ceo));
  x.snapshot.comments.push(comment('clear',body.replace('HEAD',x.contract.head),at(2000),ceo));
  x.nowMs+=302000;assert.throws(()=>evaluateForkTickets(x));
 });
 test(`${label}: standalone current prohibition rejects`,()=>{const x=fixture(),{ceo}=timed(x);x.snapshot.comments.push(comment('deny',`Do not merge at exact head ${x.contract.head}.`,new Date(x.nowMs).toISOString(),ceo));assert.throws(()=>evaluateForkTickets(x));});
 test(`${label}: standalone affirmative authority control`,()=>{const x=fixture(),{ceo}=timed(x),at=n=>new Date(x.nowMs+n).toISOString();x.snapshot.comments.push(comment('deny',`Do not merge at exact head ${x.contract.head}.`,at(1000),ceo),comment('clear',`I authorize merge at exact head ${x.contract.head}.`,at(2000),ceo));x.nowMs+=302000;assert.doesNotThrow(()=>evaluateForkTickets(x));});
}

for(const [label,fixture] of [['hold regression', tickets]]){
 for(const where of ['gate','ancestor','required description'])test(`${label}: ${where} conversational hold must block without any clearance`,()=>{
 const x=fixture(),ceo=x.actors.find(a=>a.role==='ceo').id,t=new Date(x.nowMs).toISOString(),body='My rec: hold, do not approve yet.';
 if(where==='required description'){x.contract.requiredVerdicts=[{ticket:'security',reviewerId:'security-reviewer'}];x.required=[{issue:{id:'security',createdAt:t,updatedAt:t,createdByAgentId:ceo,description:body},comments:[comment('team-pass',`PASS ${x.contract.head}`,t,'security-reviewer')],authorityScope:[]}];}else (where==='gate'?x.snapshot.comments:x.snapshot.authorityScope).push(comment('hold',body,t,ceo));
 x.nowMs+=600000;assert.throws(()=>evaluateForkTickets(x));
 });
 for(const body of ['HOLD: do not approve yet.','HOLD for exact head HEAD.'])test(`${label}: explicit hold control ${body}`,()=>{const x=fixture(),ceo=x.actors.find(a=>a.role==='ceo').id;x.snapshot.comments.push(comment('hold',body.replace('HEAD',x.contract.head),new Date(x.nowMs).toISOString(),ceo));assert.throws(()=>evaluateForkTickets(x));});
}
test('recognized conversational hold survives clause inventory',()=>{const body='My rec: hold, do not approve yet.';assert.equal(isHold(body),true);assert.equal(hasHoldForHead(body,'a'.repeat(40)),true);});

for (const body of [
  `Do not, under any circumstances, merge at exact head ${head}, and don't merge at exact head ${oldBoundaryHead}.`,
  `Do not merge at exact head ${oldBoundaryHead}, but mustn’t deploy this candidate.`,
  `No hold applies to old head ${oldBoundaryHead}, but hold for exact head ${head}.`,
]) test(`qualified or adjacent restriction retains its scope: ${body}`, () => {
  const x = tickets();
  x.snapshot.comments.push(comment('deny', body, '2026-11-24T12:01:00Z', 'ceo'));
  assert.throws(() => evaluateForkTickets(x));
});
test('descriptive conjunctions do not become hold directives', () => {
  const x = tickets();
  x.snapshot.authorityScope.push(comment('instructions', 'Review authority and hold evaluation. Include verdicts and hold inventories with actor, timestamps and source ID.'));
  assert.doesNotThrow(() => evaluateForkTickets(x));
});
for (const mutate of [
  c => c.body = c.body.replace('comment deny', 'comment deny-suffix'),
  c => c.body = c.body.replace('comment deny', 'description deny'),
  c => c.body = c.body.replace(head, oldBoundaryHead),
  c => c.authorAgentId = operator,
  c => c.updatedAt = '2026-11-24T12:02:01Z',
  c => c.createdAt = '2026-11-24T12:01:00Z',
  c => c.createdAt = '2026-11-24T11:59:00Z',
]) test(`authorization receipt rejects invalid binding, actor or chronology: ${mutate}`, () => {
  const x = tickets();
  const receipt = comment('authority', `I authorize merge at exact head ${head}, clearing denial at comment deny.`, '2026-11-24T12:02:00Z', 'ceo');
  x.snapshot.comments.push(comment('deny', `Do not merge at exact head ${head}.`, '2026-11-24T12:01:00Z', 'ceo'), receipt);
  x.nowMs = Date.parse('2026-11-24T12:07:00Z');
  assert.doesNotThrow(() => evaluateForkTickets(x));
  mutate(receipt);
  assert.throws(() => evaluateForkTickets(x));
});
test('standalone affirmative authorization starts five full minutes', () => {
  const x = tickets();
  x.snapshot.comments.push(comment('deny', `Do not merge at exact head ${head}.`, '2026-11-24T12:01:00Z', 'ceo'), comment('authority', `I authorize merge at exact head ${head}.`, '2026-11-24T12:02:00Z', 'ceo'));
  x.nowMs = Date.parse('2026-11-24T12:06:59Z');
  assert.throws(() => evaluateForkTickets(x), /minute/i);
  x.nowMs += 1000;
  assert.doesNotThrow(() => evaluateForkTickets(x));
});
