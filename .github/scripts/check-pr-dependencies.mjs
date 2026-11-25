#!/usr/bin/env node
/**
 * check-pr-dependencies.mjs
 * Detects new npm packages added in this PR vs. the base branch.
 * Findings are informational. Incomplete scans throw and fail the quality job.
 */
import { fileURLToPath } from 'node:url';
import { ghFetch } from './get-bot-token.mjs';

function buildContentsPath(repo, filename, ref) {
  return `/repos/${repo}/contents/${filename.split('/').map(encodeURIComponent).join('/')}?${new URLSearchParams({ ref }).toString()}`;
}

export async function resolveBaseRef(fetchFromGitHub, token, repo, prNumber, baseRef) {
  if (baseRef) {
    return baseRef;
  }

  const pr = await fetchFromGitHub(`/repos/${repo}/pulls/${prNumber}`, token);
  if (pr.base?.ref) {
    return pr.base.ref;
  }

  const repository = await fetchFromGitHub(`/repos/${repo}`, token);
  if (repository.default_branch) {
    return repository.default_branch;
  }

  throw new Error(`Unable to resolve a base branch for ${repo}#${prNumber}.`);
}

export function parseManifest(response) {
  if (typeof response?.content !== 'string' || response.encoding !== 'base64') throw new Error('Malformed manifest response');
  const content = response.content.replace(/\s/g, '');
  if (!content || Buffer.from(content, 'base64').toString('base64') !== content) throw new Error('Malformed manifest encoding');
  let pkg;
  try { pkg = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(content, 'base64'))); }
  catch { throw new Error('Malformed manifest JSON'); }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('Malformed manifest object');
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (pkg[key] !== undefined && (!pkg[key] || typeof pkg[key] !== 'object' || Array.isArray(pkg[key]) || Object.values(pkg[key]).some(v => typeof v !== 'string'))) throw new Error('Malformed dependency map');
  }
  return pkg;
}

export async function checkDependencies(files, token, repo, prNumber, baseRef, fetchFromGitHub = ghFetch, headRef = `refs/pull/${prNumber}/head`) {
  const pkgFiles = files.filter(
    f => f.filename.endsWith('package.json') &&
         !f.filename.includes('node_modules') &&
         f.status !== 'removed'
  );

  if (pkgFiles.length === 0) return { passed: true, informational: [] };

  const resolvedBaseRef = await resolveBaseRef(fetchFromGitHub, token, repo, prNumber, baseRef);
  const newPackages = new Set();

  for (const file of pkgFiles) {
    const basePath = file.previous_filename ?? file.filename;
    const [basePkg, prPkg] = await Promise.all([
      fetchFromGitHub(buildContentsPath(repo, basePath, resolvedBaseRef), token)
        .then(parseManifest)
        .catch(error => {
          // Only an added file with a typed 404 is an expected missing base.
          if (file.status === 'added' && error.status === 404) return {};
          throw error;
        }),
      fetchFromGitHub(buildContentsPath(repo, file.filename, headRef), token).then(parseManifest),
    ]);
    const dependencyNames = pkg => ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .flatMap(key => Object.keys(pkg[key] ?? {}));
    const baseDeps = new Set(dependencyNames(basePkg));
    for (const dep of dependencyNames(prPkg)) {
      if (!baseDeps.has(dep)) newPackages.add(dep);
    }
  }

  if (newPackages.size === 0) return { passed: true, informational: [] };

  const pkgList = [...newPackages].map(p => `\`${p}\``).join(', ');
  return {
    passed: true,
    informational: [
      `📦 New dependencies added: ${pkgList}. Review may take longer and new dependencies ` +
      `are less likely to be accepted — please check if existing deps cover this need.`,
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { GH_TOKEN, GH_REPO, PR_NUMBER, PR_FILES, PR_BASE_REF } = process.env;
  const files = JSON.parse(PR_FILES ?? '[]');
  const result = await checkDependencies(files, GH_TOKEN, GH_REPO, PR_NUMBER, PR_BASE_REF);
  console.log(JSON.stringify(result));
}
