import test from 'node:test';
import assert from 'node:assert/strict';
import { main, parseArgs } from './fork-merge-pr.mjs';
const head = 'a'.repeat(40), master = 'b'.repeat(40);
const argv = ['--merge', '--pr', '7', '--head', head, '--qa-ticket', 'QA-1'];
const result = () => ({ qa: { passAt: '2026-11-24T12:00:00Z', passComment: { body: `PASS\n${head}` }, eligibleAt: '2026-11-24T12:05:00Z' }, contract: { bootstrap: true }, state: { master } });
test('command re-fetches all evidence and uses explicit repository and expected head', async () => {
  let verifications = 0; const calls = [];
  await main(argv, { verify: async () => { verifications++; return result(); }, command: (bin, args, input) => { calls.push({ bin, args, input }); return JSON.stringify({ object: { sha: master } }); } });
  assert.equal(verifications, 3);
  const merge = calls.find(c => c.args[1] === 'merge');
  assert.deepEqual(merge.args, ['pr', 'merge', '7', '--repo', 'nearfolk/paperclip', '--admin', '--squash', '--match-head-commit', head]);
  assert.match(calls[0].input, /> PASS/);
  assert.equal(calls.some(c => c.args.includes('--approve')), false);
});
for (const failAt of [1, 2, 3]) test(`evidence error in snapshot ${failAt} prevents merge`, async () => {
  let count = 0; const calls = [];
  await assert.rejects(main(argv, { verify: async () => { if (++count === failAt) throw new Error('evidence unavailable'); return result(); }, command: (_bin, args) => { calls.push(args); return ''; } }), /unavailable/);
  assert.equal(calls.some(c => c[1] === 'merge'), false);
});
test('master movement in final comparison prevents merge', async () => {
  const calls = [];
  await assert.rejects(main(argv, { verify: async () => result(), command: (_bin, args) => { calls.push(args); return JSON.stringify({ object: { sha: 'c'.repeat(40) } }); } }), /Master moved/);
  assert.equal(calls.some(c => c[1] === 'merge'), false);
});
test('comment failure prevents merge', async () => {
  await assert.rejects(main(argv, { verify: async () => result(), command: () => { throw new Error('API failure'); } }), /API failure/);
});
test('verification mode never writes', async () => {
  await main(['--verify', ...argv.slice(1)], { verify: async () => result(), command: () => assert.fail('read only') });
});
test('CLI refuses missing SHA, raw bypass switches and duplicate arguments', () => {
  for (const a of [[], ['--merge'], [...argv, '--skip-qa', 'true'], [...argv, '--head', head]]) assert.throws(() => parseArgs(a));
});
