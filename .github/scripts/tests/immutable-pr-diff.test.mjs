import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { immutableSnapshot, assertCurrentPair, collectGitDiff, readGitDiff } from '../immutable-pr-diff.mjs';
import { scanSecrets } from '../check-pr-security.mjs';
const head = 'a'.repeat(40), base = 'b'.repeat(40), repo = 'nearfolk/paperclip';
const pr = () => ({ state: 'open', head: { sha: head }, base: { sha: base, repo: { full_name: repo } } });
for (const mutation of ['head', 'base', 'closed', 'repository']) {
  test(`rejects ${mutation} movement before reporting`, async () => {
    let calls = 0;
    const fetch = async path => {
      assert.equal(path, `/repos/${repo}/pulls/7`);
      const p = pr();
      if (++calls > 1) {
        if (mutation === 'head') p.head.sha = 'c'.repeat(40);
        if (mutation === 'base') p.base.sha = 'c'.repeat(40);
        if (mutation === 'closed') p.state = 'closed';
        if (mutation === 'repository') p.base.repo.full_name = 'other/repo';
      }
      return p;
    };
    await assert.rejects(immutableSnapshot(fetch, 'synthetic', repo, 7, head, base, async () => []), /stale or mismatched/);
  });
}
test('stale event is rejected before any diff work', async () => {
  await assert.rejects(immutableSnapshot(async () => ({ ...pr(), head: { sha: base } }), '', repo, 7, head, base, () => assert.fail('must not collect')), /stale/);
});
test('moving mutable file pages cannot contribute to the immutable snapshot', async () => {
  const seen = [];
  const files = Array.from({ length: 301 }, (_, i) => ({ filename: `${i}.txt`, patch: '+safe' }));
  const result = await immutableSnapshot(async path => {
    seen.push(path);
    if (path.includes('/files')) return [{ filename: 'wrong-head' }];
    return pr();
  }, '', repo, 7, head, base, async (_token, _repo, h, b) => {
    assert.equal(h, head); assert.equal(b, base); return files;
  });
  assert.equal(result.files.length, 301);
  assert.equal(seen.some(p => p.includes('/files')), false);
});
for (const failure of ['403', 'timeout', 'malformed JSON']) {
  test(`API ${failure} fails before report`, async () => {
    await assert.rejects(assertCurrentPair(async () => { throw new Error(failure); }, '', repo, 7, head, base), new RegExp(failure));
  });
}
for (const inventory of ['M\0file', 'M\0', 'R100\0old\0new\0', 'M\0a\0M\0a\0']) {
  test(`rejects incomplete/unsupported inventory ${JSON.stringify(inventory)}`, () => {
    assert.throws(() => readGitDiff(args => args.includes('--name-status') ? inventory : 'diff --git a/a b/a\n', base, head));
  });
}
test('truncated patches and collection failures never become an empty success', async () => {
  assert.throws(() => readGitDiff(args => args.includes('--name-status') ? 'M\0file\0' : 'diff --git partial', base, head), /Incomplete/);
  await assert.rejects(immutableSnapshot(async () => pr(), '', repo, 7, head, base, () => { throw new Error('maxBuffer'); }), /maxBuffer/);
});
test('missing or malformed event SHA fails closed', async () => {
  for (const h of ['', undefined, 'main', `${head};touch bad`]) await assert.rejects(assertCurrentPair(async () => pr(), '', repo, 7, h, base), /required/);
});
test('real Git collects every immutable file, handles literal paths, and never executes candidate code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diff-fixture-'));
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['init']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'fixture']);
    writeFileSync(join(dir, 'base.txt'), 'base\n'); git(['add', '.']); git(['commit', '-m', 'base']); const b = git(['rev-parse', 'HEAD']);
    for (let i = 0; i < 301; i++) writeFileSync(join(dir, `${i}.txt`), `safe ${i}\n`);
    writeFileSync(join(dir, ':(glob)*.txt'), 'secret="abcdefghijklmnopqrstuvwxyz012345"\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { postinstall: `touch ${dir}/EXECUTED` } }));
    git(['add', '.']); git(['commit', '-m', 'candidate']); const h = git(['rev-parse', 'HEAD']);
    const files = collectGitDiff('synthetic', repo, h, b, { source: dir });
    assert.equal(files.length, 303); assert.equal(existsSync(join(dir, 'EXECUTED')), false);
    assert.equal(scanSecrets(files).length, 1);
    assert.throws(() => collectGitDiff('synthetic', repo, head, b, { source: dir }), /collection failed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const { reviewSecurity } = await import('../check-pr-security.mjs');
for (const moveAt of [1, 2, 3]) test(`security runner cannot post success when metadata moves at read ${moveAt}`, async () => {
  let reads = 0, reports = 0;
  const fetch = async (path, _token, options) => {
    if (path.endsWith('/pulls/7')) {
      const p = pr(); if (++reads >= moveAt) p.head.sha = 'c'.repeat(40); return p;
    }
    if (path.includes('/contents/')) { assert.match(path, new RegExp(`ref=${base}$`)); return {}; }
    if (options?.method === 'POST') { reports++; return {}; }
    assert.fail(path);
  };
  await assert.rejects(reviewSecurity({ GH_TOKEN: 'synthetic', GH_REPO: repo, PR_NUMBER: 7, PR_HEAD_SHA: head, PR_BASE_SHA: base }, fetch, async () => []), /stale/);
  assert.equal(reports, 0);
});
test('security runner reports only the immutable event head with all scanners intact', async () => {
  let report;
  const fetch = async (path, _token, options) => {
    if (path.endsWith('/pulls/7')) return { ...pr(), number: 7 };
    if (path.includes('/contents/')) return {};
    if (path.endsWith('/check-runs')) { report = JSON.parse(options.body); return {}; }
    assert.fail(path);
  };
  await reviewSecurity({ GH_TOKEN: 'synthetic', GH_REPO: repo, PR_NUMBER: 7, PR_HEAD_SHA: head, PR_BASE_SHA: base }, fetch, async () => [{ filename: '.github/workflows/test.yml', status: 'modified', patch: '+secret="abcdefghijklmnopqrstuvwxyz012345"' }]);
  assert.equal(report.head_sha, head); assert.equal(report.conclusion, 'neutral');
  assert.match(report.output.summary, /ci-tampering/); assert.match(report.output.summary, /secret-scan/);
  assert.equal(JSON.stringify(report).includes('abcdefghijklmnopqrstuvwxyz'), false);
});
