import { createHash } from 'node:crypto';
import { evaluateQaTicket, evaluateRequiredVerdict, isHold, isClearance, isFail, isFailRetraction, parseFailRetractionReceipt } from './fork-ticket-authority.mjs';

export const REPOSITORY = 'nearfolk/paperclip';
export const BOOTSTRAP_BASE = '916c13501f80c7d1d659b89e4a06dc47366aa80f';
export const ORIGINAL_FAILED_HEAD = 'ee560a3b4959b762f2294dd4c679b907760b8879';
export const OLD_REVIEW_DIGEST = '1b600922fd0a4a7799503791266f4eb3a08a8fb096e9548168e42a99096ccaee';
export const PR_WORKFLOW_DIGEST = '9c554157ae4dce6f64428970604d1de1835f7664d1bf15b62830d1ca35aabfe9';
export const REQUIRED_JOBS = [
  'policy', 'Typecheck + Release Registry',
  ...[1, 2, 3].map(n => `General tests (server (${n}/3))`),
  'General tests (workspaces-a)', 'General tests (workspaces-b)', 'Build', 'verify',
  ...[1, 2, 3, 4].map(n => `Verify serialized server suites (${n}/4)`),
  'Canary Dry Run', 'e2e shard (1/2)', 'e2e shard (2/2)', 'e2e',
];
export const GATE_MAPPING = JSON.stringify({
  repository: REPOSITORY, base: 'master', workflow: '.github/workflows/pr.yml',
  digest: PR_WORKFLOW_DIGEST, jobs: REQUIRED_JOBS,
  freshness: 'fresh master SHA -> immutable compare behind_by=0 -> master recheck',
  review: 'exact-head QA + security + authority + original FAIL retraction + distinct CTO handoff + five minutes',
  bootstrap: { pr: 7, base: BOOTSTRAP_BASE, oldReviewDigest: OLD_REVIEW_DIGEST, failure: 'COMMITPERCLIP_KEY absent only' },
});
export const digest = text => createHash('sha256').update(text).digest('hex');
export const MAPPING_DIGEST = digest(GATE_MAPPING);
const SHA = /^[0-9a-f]{40}$/;
const fail = message => { throw new Error(message); };
const date = value => { const n = Date.parse(value); if (!Number.isFinite(n)) fail('Invalid evidence timestamp'); return n; };
const heads = body => [...new Set(String(body).match(/\b[0-9a-f]{40}\b/g) ?? [])];

export function parseContract(issue, head, prNumber) {
  const blocks = [...String(issue.description).matchAll(/```fork-release-contract\n([\s\S]*?)\n```/g)];
  if (blocks.length !== 1) fail('Exactly one fork-release-contract is required on the QA gate');
  const c = JSON.parse(blocks[0][1]);
  if (c.version !== 1 || c.repository !== REPOSITORY || c.pr !== Number(prNumber) || c.head !== head || !SHA.test(head) || c.mappingDigest !== MAPPING_DIGEST) fail('Fork release contract scope or mapping mismatch');
  if (!c.reviewerId || !c.operatorId || c.reviewerId === c.operatorId || !c.implementationTicket || !Array.isArray(c.requiredVerdicts) || !Array.isArray(c.failureHistoryTickets)) fail('Incomplete fork release contract');
  if (c.bootstrap !== false && c.bootstrap !== true) fail('Explicit bootstrap mode required');
  if (c.bootstrap && (c.pr !== 7 || c.failureHistoryTickets.length === 0)) fail('Bootstrap requires PR #7 and original verdict history');
  return c;
}

export function evaluateForkTickets({ snapshot, identity, actors, contract, histories, required, implementation, nowMs }) {
  if (identity.id !== contract.operatorId || identity.role !== 'cto' || snapshot.issue.assigneeAgentId !== identity.id) fail('Named authenticated CTO must own the operator handoff');
  if (implementation.issue.assigneeAgentId === contract.reviewerId || !String(implementation.issue.description + implementation.comments.map(x => x.body).join('\n')).includes(contract.head)) fail('Implementation must name the head and have an independent author');
  if (histories.length !== contract.failureHistoryTickets.length || required.length !== contract.requiredVerdicts.length) fail('Incomplete declared verdict history');
  const historySources = histories.flatMap(s => [
    { body: s.issue.description, createdAt: s.issue.createdAt, authorAgentId: s.issue.createdByAgentId, sourceIssueId: s.issue.id, sourceKind: 'issue_description' },
    ...s.comments.map(c => ({ ...c, sourceIssueId: s.issue.id })), ...s.authorityScope,
  ]);
  const qa = evaluateQaTicket({ ...snapshot,
    authorityScope: [...snapshot.authorityScope, ...historySources, ...required.flatMap(s => [...s.comments, ...s.authorityScope]), ...(implementation.authorityScope ?? [])],
    expectedHead: contract.head, operatorId: identity.id, authorityActors: actors, nowMs,
  });
  if (qa.reviewerId !== contract.reviewerId) fail('PASS is not from the designated independent QA seat');
  if (!snapshot.activity.some(e => e.action === 'issue.updated' && e.actorId === contract.reviewerId && e.details?.assigneeAgentId === identity.id && e.details?._previous?.assigneeAgentId === contract.reviewerId && date(e.createdAt) >= date(qa.passAt))) fail('Reviewer-authored operator assignment is required');
  if (qa.passComment.updatedAt && date(qa.passComment.updatedAt) !== date(qa.passAt)) fail('Edited PASS requires a new immutable verdict comment');
  const pass = qa.passComment.body;
  if (heads(pass.replace(`Bootstrap exception: PR #7 base ${BOOTSTRAP_BASE}; missing COMMITPERCLIP_KEY only.`, '')).length !== 1 || !pass.includes(`Fork gate mapping: ${MAPPING_DIGEST}`) || !/Security verdict: PASS\b/.test(pass)) fail('Exact-head security PASS and explicit fork mapping acceptance required');
  if (!contract.requiredVerdicts.length && !qa.noOtherVerdictsRecorded) fail('Required team verdict inventory is not declared');
  let eligibleAt = date(qa.eligibleAt);
  for (let i = 0; i < required.length; i++) {
    const declaration = contract.requiredVerdicts[i];
    const verdict = evaluateRequiredVerdict({ ...required[i], expectedHead: contract.head });
    if (!declaration.reviewerId || declaration.reviewerId === implementation.issue.assigneeAgentId || verdict.passComment.authorAgentId !== declaration.reviewerId || heads(verdict.passComment.body).length !== 1) fail('Required team verdict author or head mismatch');
    eligibleAt = Math.max(eligibleAt, date(verdict.passComment.createdAt) + 300_000);
  }
  // Across heads and across tickets: no PASS can outrun an original QA FAIL.
  const allComments = [...snapshot.comments, ...historySources, ...required.flatMap(s => s.comments)];
  const failures = allComments.filter(c => isFail(c.body) && !isFailRetraction(c.body));
  if (contract.bootstrap && !failures.some(c => c.authorAgentId === contract.reviewerId && String(c.body).includes(ORIGINAL_FAILED_HEAD))) fail('Original QA FAIL history is missing');
  for (const failure of failures) {
    const retraction = allComments.find(c => {
      const receipt = parseFailRetractionReceipt(c.body);
      return c.authorAgentId === failure.authorAgentId && c.id !== failure.id
        && receipt?.head === contract.head && receipt.commentId === failure.id
        && (!c.updatedAt || date(c.updatedAt) === date(c.createdAt))
        && date(c.createdAt) > date(failure.createdAt) && date(c.createdAt) < date(qa.passAt);
    });
    if (!retraction) fail(`Unretracted FAIL: ${failure.id}`);
  }
  // Holds in any declared ticket/ancestor apply regardless of author. Only the
  // same actor (or CEO/board) can clear one, naming this head and its source id.
  const sources = [{ body: snapshot.issue.description, createdAt: snapshot.issue.createdAt, authorAgentId: snapshot.issue.createdByAgentId }, ...snapshot.comments, ...snapshot.authorityScope, ...historySources, ...required.flatMap(s => [...s.comments, ...s.authorityScope])];
  for (const hold of sources.filter(c => isHold(c.body))) {
    if (heads(hold.body).length && !heads(hold.body).includes(contract.head)) continue;
    const clearance = sources.find(c => isClearance(c.body) && heads(c.body).length === 1 && heads(c.body)[0] === contract.head && hold.id && String(c.body).includes(hold.id) && date(c.createdAt) > date(hold.createdAt) && (c.authorAgentId === hold.authorAgentId || actors.some(a => a.id === c.authorAgentId && ['ceo', 'board'].includes(a.role))));
    if (!clearance) fail('Open or ambiguous ticket/ancestor hold');
    eligibleAt = Math.max(eligibleAt, date(clearance.createdAt) + 300_000);
  }
  if (contract.bootstrap && !pass.includes(`Bootstrap exception: PR #7 base ${BOOTSTRAP_BASE}; missing COMMITPERCLIP_KEY only.`)) fail('QA has not accepted the bounded bootstrap exception');
  if (!Number.isFinite(nowMs) || nowMs < eligibleAt) fail('Five full minutes have not elapsed since the last qualifying verdict/clearance');
  return { ...qa, eligibleAt: new Date(eligibleAt).toISOString() };
}

export function evaluateForkGithub({ pr, master, compare, workflow, run, jobs, reviewRun, reviewJobs, reviewLog, oldReview, checks, reviews, contract }) {
  if (pr.state !== 'OPEN' || pr.isDraft || pr.headRefOid !== contract.head || pr.baseRefName !== 'master' || pr.baseRefOid !== master || !SHA.test(master ?? '')) fail('PR head/base/state changed');
  if (compare.base_commit?.sha !== master || compare.behind_by !== 0 || !['ahead', 'identical'].includes(compare.status)) fail('Fresh master comparison failed or is incomplete');
  if (digest(workflow) !== PR_WORKFLOW_DIGEST) fail('PR workflow differs from the independently reviewed fork gate mapping');
  if (run.path !== '.github/workflows/pr.yml' || run.event !== 'pull_request' || run.head_sha !== contract.head || run.status !== 'completed' || run.conclusion !== 'success') fail('Exact-head ordinary CI run has not passed');
  if (!Array.isArray(jobs) || jobs.length !== REQUIRED_JOBS.length || new Set(jobs.map(j => j.name)).size !== jobs.length) fail('Ordinary CI job inventory incomplete or unexpected');
  for (const name of REQUIRED_JOBS) {
    const j = jobs.find(j => j.name === name);
    if (!j || j.run_id !== run.id || j.head_sha !== contract.head || j.status !== 'completed' || j.conclusion !== 'success') fail(`Required CI failed or absent: ${name}`);
  }
  if (reviewRun.path !== '.github/workflows/commitperclip-review.yml' || reviewRun.event !== 'pull_request_target' || reviewRun.head_sha !== contract.head || reviewRun.status !== 'completed') fail('Review run provenance mismatch or pending');
  if (!Array.isArray(reviewJobs) || reviewJobs.length !== 1 || reviewJobs[0].name !== 'review' || reviewJobs[0].run_id !== reviewRun.id || reviewJobs[0].head_sha !== contract.head) fail('Review job inventory mismatch');
  if (contract.bootstrap) {
    if (contract.pr !== 7 || master !== BOOTSTRAP_BASE || digest(oldReview) !== OLD_REVIEW_DIGEST || reviewRun.conclusion !== 'failure') fail('Bootstrap exception is out of scope');
    const failed = reviewJobs[0].steps.filter(s => s.conclusion === 'failure');
    if (reviewJobs[0].conclusion !== 'failure' || failed.length !== 1 || failed[0].name !== 'Generate commitperclip token' || !reviewLog.includes('ERROR: COMMITPERCLIP_KEY env var not set.')) fail('Review failure is not the bounded missing-key bootstrap');
    for (const name of ['Checkout base branch (never PR code)', 'Dependency Review', 'Set up Node']) {
      if (!reviewJobs[0].steps.some(s => s.name === name && s.conclusion === 'success')) fail('Bootstrap prerequisite failed');
    }
  } else {
    if (reviewRun.conclusion !== 'success' || reviewJobs[0].conclusion !== 'success') fail('Review workflow has not passed');
    const security = checks.filter(c => c.name === 'security-review');
    if (!security.length || security.some(c => c.head_sha !== contract.head || c.app?.slug !== 'github-actions' || c.status !== 'completed' || !['success', 'neutral'].includes(c.conclusion))) fail('Exact-head security scan missing or failed');
  }
  if (!Array.isArray(reviews)) fail('GitHub review history unavailable');
  const latest = new Map();
  for (const r of [...reviews].sort((a, b) => date(a.submitted_at) - date(b.submitted_at))) latest.set(r.user.login, r);
  if ([...latest.values()].some(r => r.state === 'CHANGES_REQUESTED')) fail('Unresolved GitHub changes requested');
  // No unrelated success can substitute for a required workflow job. Conversely,
  // additional failed checks block; only the explicit old-base failure is exempt.
  for (const c of checks) {
    if (c.head_sha !== contract.head || c.status !== 'completed') fail('Check is stale or pending');
    if (c.name === 'security-review' && c.conclusion === 'neutral') continue;
    if (c.name === 'review' && contract.bootstrap && c.details_url?.includes(`/runs/${reviewRun.id}/`)) continue;
    if (c.name === 'Storybook visual regression' && c.conclusion === 'skipped' && !pr.labels.some(l => l.name === 'storybook-visual')) continue;
    if (c.conclusion !== 'success') fail(`Additional check is not successful: ${c.name}`);
  }
  return { freshness: 'fresh immutable master comparison', bootstrap: contract.bootstrap };
}
