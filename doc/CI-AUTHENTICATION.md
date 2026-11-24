# Fork CI authentication

The review workflow uses the short-lived `github.token` supplied by GitHub Actions
for this repository. No upstream App private key or personal access token is
required. The repository owner controls workflow permissions: contents read,
pull requests write (quality comments), and checks write (security results).
The token expires with the job. Checkout does not persist it in Git configuration.

`pull_request_target` executes trusted base code at the event's immutable base SHA.
It never checks out or executes the PR head. The PR diff is API data only.
Keep this boundary when updating the workflow. Dependency Review and all six
quality/security scanners remain enabled. Quality failures fail the review job;
security reporting errors also fail the job rather than silently suppressing them.

## Security reporting

The repository token cannot create private repository security advisories.
`SECURITY_REPORT_MODE=check-run` publishes a `security-review` check on the exact
PR head instead. Findings retain the existing informational `neutral` conclusion;
they are not an independent security approval. Maintainers must review the diff
before release. The check shows only flag counts and fixed scanner categories,
never matched secret text, file paths, or PR titles. No private advisory is created.
A clean scan reports success. The existing advisory mode is retained for other
callers with appropriate credentials, but this fork workflow does not invoke it.

## Activation and verification

Merge this workflow repair through the repository review process before resuming
blocked safeguard PRs. A rerun of an old workflow uses the old workflow definition;
it cannot prove the repair. Generate a new pull-request event after activation
(for example, update the candidate branch to the new base), then verify a new
`commitperclip PR Review / review` run and its exact-head `security-review` check.
Do not rerun historical PR jobs as evidence for a current candidate.

Verify quality-comment upserts use `github-actions[bot]` and no request for
`COMMITPERCLIP_KEY` remains in this workflow. Re-run independent QA and all release
checks on each updated safeguard PR. CI repair alone does not authorize release.

Local regression command:

```sh
node --test .github/scripts/tests/*.test.mjs
```
