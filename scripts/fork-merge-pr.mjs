#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseContract, evaluateForkTickets, evaluateForkGithub, REPOSITORY } from './fork-gate-policy.mjs';

function command(bin, args, input) {
  try { return execFileSync(bin, args, { encoding: 'utf8', input, timeout: 60_000, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { throw new Error(`${bin} evidence request or operation failed`); }
}
const gh = args => JSON.parse(command('gh', args));
const api = path => gh(['api', `repos/${REPOSITORY}/${path}`]);
function paged(path, key) {
  const pages = gh(['api', '--paginate', '--slurp', `repos/${REPOSITORY}/${path}`]);
  if (!Array.isArray(pages) || !pages.length) throw new Error('Missing paginated evidence');
  if (!key) {
    if (pages.some(p => !Array.isArray(p))) throw new Error('Malformed paginated evidence');
    return pages.flat();
  }
  const count = pages[0].total_count;
  if (!Number.isInteger(count) || pages.some(p => !Array.isArray(p[key]) || p.total_count !== count)) throw new Error('Incomplete or moving paginated evidence');
  const rows = pages.flatMap(p => p[key]);
  if (rows.length !== count || new Set(rows.map(r => r.id)).size !== count) throw new Error('Truncated or duplicate evidence');
  return rows;
}
function content(path, ref) {
  const r = api(`contents/${path}?ref=${ref}`);
  if (r.encoding !== 'base64' || typeof r.content !== 'string') throw new Error('Immutable workflow content unavailable');
  return Buffer.from(r.content, 'base64').toString('utf8');
}
function config() {
  const { PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_AGENT_ID } = process.env;
  if (!PAPERCLIP_API_URL || !PAPERCLIP_API_KEY || !PAPERCLIP_AGENT_ID) throw new Error('Authenticated Paperclip operator context required');
  return { url: PAPERCLIP_API_URL.replace(/\/$/, '').replace(/\/api$/, ''), token: PAPERCLIP_API_KEY, operator: PAPERCLIP_AGENT_ID };
}
async function paperclip(path, cfg) {
  // Keep the bearer token off argv and use the same bounded curl path as agents.
  const data = command('curl', ['--fail', '--silent', '--show-error', '--max-time', '30', '--config', '-'],
    `url = ${JSON.stringify(`${cfg.url}/api${path}`)}\nheader = ${JSON.stringify(`Authorization: Bearer ${cfg.token}`)}\n`);
  return JSON.parse(data);
}
export async function ticket(reference, cfg) {
  const ref = encodeURIComponent(reference);
  const [issue, comments, activity, interactions] = await Promise.all([
    paperclip(`/issues/${ref}`, cfg), paperclip(`/issues/${ref}/comments`, cfg),
    paperclip(`/issues/${ref}/activity`, cfg), paperclip(`/issues/${ref}/interactions`, cfg),
  ]);
  if (!Array.isArray(issue.ancestors) || !Array.isArray(comments) || !Array.isArray(activity) || !Array.isArray(interactions)) throw new Error('Authoritative ticket history unavailable');
  const authorityScope = [];
  for (const ancestor of issue.ancestors) {
    if (!ancestor.id) throw new Error('Ancestor identity unavailable');
    const a = await paperclip(`/issues/${encodeURIComponent(ancestor.id)}`, cfg);
    const c = await paperclip(`/issues/${encodeURIComponent(ancestor.id)}/comments`, cfg);
    if (!Array.isArray(c)) throw new Error('Ancestor history unavailable');
    authorityScope.push({ body: a.description, authorAgentId: a.createdByAgentId, createdAt: a.createdAt, sourceIssueId: a.id, sourceIssueIdentifier: a.identifier, sourceKind: 'issue_description' }, ...c.map(x => ({ ...x, sourceIssueId: a.id })));
  }
  return { issue, comments, activity, interactions, authorityScope };
}
function latestRun(path, head) {
  const runs = paged(`actions/workflows/${path}/runs?head_sha=${head}&per_page=100`, 'workflow_runs')
    .filter(r => r.head_sha === head).sort((a, b) => b.id - a.id);
  if (!runs.length) throw new Error(`No exact-head run: ${path}`);
  return api(`actions/runs/${runs[0].id}`);
}
function github(contract) {
  const pr = gh(['pr', 'view', String(contract.pr), '--repo', REPOSITORY, '--json', 'state,isDraft,headRefOid,baseRefOid,baseRefName,labels']);
  const master = api('git/ref/heads/master').object.sha;
  const run = latestRun('pr.yml', contract.head);
  const reviewRun = latestRun('commitperclip-review.yml', contract.head);
  const checks = paged(`commits/${contract.head}/check-runs?per_page=100&filter=latest`, 'check_runs');
  const statuses = paged(`commits/${contract.head}/statuses?per_page=100`);
  const latestStatuses = new Map();
  for (const s of statuses) if (!latestStatuses.has(s.context)) latestStatuses.set(s.context, s);
  if ([...latestStatuses.values()].some(s => s.state !== 'success')) throw new Error('Additional commit status failed or pending');
  return {
    pr, master, compare: api(`compare/${master}...${contract.head}`),
    workflow: content('.github/workflows/pr.yml', contract.head), run,
    jobs: paged(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, 'jobs'),
    reviewRun, reviewJobs: paged(`actions/runs/${reviewRun.id}/attempts/${reviewRun.run_attempt}/jobs?per_page=100`, 'jobs'),
    reviewLog: contract.bootstrap ? command('gh', ['run', 'view', String(reviewRun.id), '--repo', REPOSITORY, '--log-failed']) : '',
    oldReview: contract.bootstrap ? content('.github/workflows/commitperclip-review.yml', master) : '',
    checks, reviews: paged(`pulls/${contract.pr}/reviews?per_page=100`), contract,
  };
}
export async function verify(args, cfg = config()) {
  const snapshot = await ticket(args.qaTicket, cfg);
  const contract = parseContract(snapshot.issue, args.head, args.pr);
  const identity = await paperclip('/agents/me', cfg);
  if (identity.id !== cfg.operator || !Array.isArray(identity.chainOfCommand)) throw new Error('Operator identity unavailable');
  const actors = [identity, ...identity.chainOfCommand];
  const [histories, required, implementation] = await Promise.all([
    Promise.all(contract.failureHistoryTickets.map(ref => ticket(ref, cfg))),
    Promise.all(contract.requiredVerdicts.map(v => ticket(v.ticket, cfg))),
    ticket(contract.implementationTicket, cfg),
  ]);
  const qa = evaluateForkTickets({ snapshot, identity, actors, contract, histories, required, implementation, nowMs: Date.now() });
  const state = github(contract);
  const evaluation = evaluateForkGithub(state);
  return { qa, contract, state, evaluation };
}
export function parseArgs(argv) {
  if (!['--verify', '--merge'].includes(argv[0])) throw new Error('Choose --verify or --merge');
  const args = { mode: argv[0] };
  for (let i = 1; i < argv.length; i += 2) {
    const field = { '--pr': 'pr', '--head': 'head', '--qa-ticket': 'qaTicket' }[argv[i]];
    if (!field || args[field] || !argv[i + 1]) throw new Error('Unknown, repeated or missing argument');
    args[field] = argv[i + 1];
  }
  if (!/^[1-9]\d*$/.test(args.pr ?? '') || !/^[a-f0-9]{40}$/.test(args.head ?? '') || !args.qaTicket) throw new Error('PR, full head and QA ticket required');
  return args;
}
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const verifyNow = dependencies.verify ?? verify;
  const run = dependencies.command ?? command;
  // Timing preflight is discarded. Never reuse a pre-wait authorization snapshot.
  await verifyNow(args);
  let result = await verifyNow(args);
  if (args.mode === '--merge') {
    const quote = `Designated QA verdict from ${args.qaTicket}, ${result.qa.passAt}:\n\n${result.qa.passComment.body.split('\n').map(l => `> ${l}`).join('\n')}`;
    run('gh', ['pr', 'comment', args.pr, '--repo', REPOSITORY, '--body-file', '-'], quote);
    // Re-read tickets, ancestors, handoff, CI and master after the comment write.
    result = await verifyNow(args);
    const latest = JSON.parse(run('gh', ['api', `repos/${REPOSITORY}/git/ref/heads/master`]));
    if (latest.object.sha !== result.state.master) throw new Error('Master moved immediately before merge');
    run('gh', ['pr', 'merge', args.pr, '--repo', REPOSITORY, '--admin', '--squash', '--match-head-commit', args.head]);
  }
  console.log(`Fork gate ${args.mode === '--merge' ? 'merge submitted' : 'verified'} at ${args.head}; eligible ${result.qa.eligibleAt}; freshness: immutable master comparison; bootstrap: ${result.contract.bootstrap}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('Protected fork activation failed. No eligibility can be inferred. Inspect the failing evidence with read-only tools.');
  process.exitCode = 1;
});
