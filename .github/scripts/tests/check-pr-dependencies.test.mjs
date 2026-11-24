import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDependencies, resolveBaseRef } from '../check-pr-dependencies.mjs';

test('resolveBaseRef: returns the explicit base ref without making API calls', async () => {
  const baseRef = await resolveBaseRef(async () => {
    throw new Error('should not fetch');
  }, 'token', 'paperclipai/paperclip', 6469, 'release/1.2');

  assert.equal(baseRef, 'release/1.2');
});

test('resolveBaseRef: falls back to the PR base ref', async () => {
  const seenPaths = [];
  const baseRef = await resolveBaseRef(async (path) => {
    seenPaths.push(path);
    return { base: { ref: 'main' } };
  }, 'token', 'paperclipai/paperclip', 6469);

  assert.equal(baseRef, 'main');
  assert.deepEqual(seenPaths, ['/repos/paperclipai/paperclip/pulls/6469']);
});

test('checkDependencies: compares package files against the resolved base ref instead of master', async () => {
  const seenPaths = [];
  const result = await checkDependencies(
    [{ filename: 'packages/foo/package.json', status: 'modified' }],
    'token',
    'paperclipai/paperclip',
    6469,
    'release/1.2',
    async (path) => {
      seenPaths.push(path);

      if (path.includes('ref=release%2F1.2')) {
        return {
          encoding: 'base64',
          content: Buffer.from(JSON.stringify({
            dependencies: { existing: '^1.0.0' },
          })).toString('base64'),
        };
      }

      if (path.includes('ref=refs%2Fpull%2F6469%2Fhead')) {
        return {
          encoding: 'base64',
          content: Buffer.from(JSON.stringify({
            dependencies: {
              existing: '^1.0.0',
              added: '^2.0.0',
            },
          })).toString('base64'),
        };
      }

      throw new Error(`Unexpected path: ${path}`);
    }
  );

  assert.equal(result.passed, true);
  assert.equal(result.informational.length, 1);
  assert.match(result.informational[0], /`added`/);
  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/contents/packages/foo/package.json?ref=release%2F1.2',
    '/repos/paperclipai/paperclip/contents/packages/foo/package.json?ref=refs%2Fpull%2F6469%2Fhead',
  ]);
});

const manifest = pkg => ({ encoding: 'base64', content: Buffer.from(JSON.stringify(pkg)).toString('base64') });
for (const [name, failure] of [
  ['403', Object.assign(new Error('forbidden'), { status: 403 })],
  ['rate limit', Object.assign(new Error('rate limited'), { status: 429 })],
  ['timeout', new Error('timeout')], ['transport', new Error('connection reset')],
]) {
  for (const side of ['base', 'head']) test(`dependency ${side} ${name} rejects incomplete scan`, async () => {
    await assert.rejects(checkDependencies([{ filename: 'package.json', status: 'added' }], '', 'nearfolk/paperclip', 7, 'base', async path => {
      if (path.endsWith(`ref=${side}`)) throw failure;
      return manifest({});
    }, 'head'), error => error === failure);
  });
}
for (const data of [{}, { content: 'not base64!' }, manifest(null), manifest([]), manifest({ dependencies: [] }), { content: Buffer.from('{bad').toString('base64') }]) {
  test(`malformed dependency data fails: ${JSON.stringify(data)}`, async () => {
    await assert.rejects(checkDependencies([{ filename: 'package.json', status: 'modified' }], '', 'nearfolk/paperclip', 7, 'base', async () => data, 'head'), /Malformed/);
  });
}
test('legitimately new manifest counts all dependencies with pinned head/base', async () => {
  const seen = [];
  const result = await checkDependencies([{ filename: 'new/package.json', status: 'added' }], '', 'nearfolk/paperclip', 7, 'b'.repeat(40), async path => {
    seen.push(path);
    if (path.endsWith('b'.repeat(40))) throw Object.assign(new Error('missing'), { status: 404 });
    return manifest({ dependencies: { newdep: '1' }, optionalDependencies: { opt: '2' } });
  }, 'a'.repeat(40));
  assert.match(result.informational[0], /newdep/); assert.match(result.informational[0], /opt/);
  assert.equal(seen.every(p => !p.includes('refs%2Fpull')), true);
});
test('404 for an existing base or for the candidate is an error', async () => {
  for (const status of ['modified', 'added']) await assert.rejects(checkDependencies([{ filename: 'package.json', status }], '', 'nearfolk/paperclip', 7, 'base', async () => { throw Object.assign(new Error('missing'), { status: 404 }); }, 'head'));
});
test('manifest paths cannot replace the pinned ref query', async () => {
  const paths = [];
  await checkDependencies([{ filename: 'odd?ref=master&x=#/package.json', status: 'modified' }], '', 'nearfolk/paperclip', 7, 'b'.repeat(40), async path => { paths.push(path); return manifest({}); }, 'a'.repeat(40));
  for (const path of paths) {
    const url = new URL(path, 'https://api.github.com');
    assert.equal(url.searchParams.size, 1);
    assert.match(url.searchParams.get('ref'), /^[ab]{40}$/);
    assert.equal(url.hash, '');
  }
});
