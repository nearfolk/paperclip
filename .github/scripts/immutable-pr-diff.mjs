import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHA = /^[0-9a-f]{40}$/;
export function validatePair(repo, number, head, base) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[1-9]\d*$/.test(String(number)) || !SHA.test(head ?? '') || !SHA.test(base ?? '')) {
    throw new Error('Repository, PR number and exact event head/base SHAs are required');
  }
}

export async function assertCurrentPair(fetch, token, repo, number, head, base) {
  validatePair(repo, number, head, base);
  const pr = await fetch(`/repos/${repo}/pulls/${number}`, token);
  if (pr.state !== 'open' || pr.head?.sha !== head || pr.base?.sha !== base || pr.base?.repo?.full_name !== repo) {
    throw new Error('PR snapshot is stale or mismatched');
  }
  return pr;
}

// Read Git objects in a fresh bare repository. No checkout, hooks, candidate
// scripts, attributes, external diff driver or textconv can execute. Git verifies
// pack integrity; missing objects, shallow history, timeout and buffer overflow
// all throw. Unlike the pulls/files API, this has no mutable pages or 3000-file cap.
export function collectGitDiff(token, repo, head, base, { source } = {}) {
  validatePair(repo, 1, head, base);
  const dir = mkdtempSync(join(tmpdir(), 'pr-diff-'));
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
  const git = (args) => {
    try {
      return execFileSync('git', ['--no-pager', ...args], {
        cwd: dir, env, encoding: 'utf8', timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // Git errors can include remote data. Keep public logs content-free.
      throw new Error('Immutable diff collection failed or exceeded its size/time bound');
    }
  };
  try {
    git(['init', '--bare', '.']);
    git(['-c', 'fetch.fsckObjects=true', 'fetch', '--no-tags', '--no-write-fetch-head', source ?? `https://github.com/${repo}.git`, base, head]);
    for (const sha of [base, head]) {
      if (git(['rev-parse', '--verify', `${sha}^{commit}`]).trim() !== sha) throw new Error('Commit mismatch');
    }
    const bases = git(['merge-base', '--all', base, head]).trim().split('\n');
    if (bases.length !== 1 || !SHA.test(bases[0])) throw new Error('Ambiguous or missing merge base');
    return readGitDiff(git, bases[0], head);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readGitDiff(git, base, head) {
  const options = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none'];
  const raw = git([...options, '--name-status', '-z', base, head, '--']);
  if (raw && !raw.endsWith('\0')) throw new Error('Incomplete diff inventory');
  const entries = raw ? raw.slice(0, -1).split('\0') : [];
  if (entries.length % 2) throw new Error('Incomplete diff inventory');
  const files = [];
  const seen = new Set();
  for (let i = 0; i < entries.length; i += 2) {
    const [status, filename] = entries.slice(i, i + 2);
    if (!['A', 'M', 'D', 'T'].includes(status) || !filename || seen.has(filename)) throw new Error('Unsupported diff entry');
    seen.add(filename);
    const patch = git([...options, '--text', '--unified=3', base, head, '--', `:(literal)${filename}`]);
    if (!patch.startsWith('diff --git ') || !patch.endsWith('\n')) throw new Error('Incomplete diff patch');
    files.push({ filename, status: { A: 'added', M: 'modified', D: 'removed', T: 'modified' }[status], patch });
  }
  return files;
}

export async function immutableSnapshot(fetch, token, repo, number, head, base, collect = collectGitDiff) {
  const pr = await assertCurrentPair(fetch, token, repo, number, head, base);
  const files = await collect(token, repo, head, base);
  await assertCurrentPair(fetch, token, repo, number, head, base);
  return { pr, files };
}
