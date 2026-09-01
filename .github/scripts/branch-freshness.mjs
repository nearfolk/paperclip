const SHA_PATTERN = /^[0-9a-f]{40}$/

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requireSha(value, field) {
  if (!SHA_PATTERN.test(value ?? '')) {
    throw new Error(`${field} did not provide an exact 40-character SHA`)
  }
  return value
}

export function successDescription(protectedBase, baseSha) {
  return `Protected ${protectedBase} ${baseSha} is included in this head.`
}

export function computeFreshnessStatus({
  comparison,
  protectedBase,
  observedHeadSha,
  observedBaseSha,
  liveHeadSha,
  liveBaseSha,
}) {
  requireSha(observedHeadSha, 'Observed pull request head')
  requireSha(observedBaseSha, 'Observed protected base')

  if (liveHeadSha !== observedHeadSha || liveBaseSha !== observedBaseSha) {
    return {
      state: 'error',
      description: `Comparison for protected ${protectedBase} ${observedBaseSha} became stale.`,
      stale: true,
    }
  }

  if (
    !isRecord(comparison)
    || comparison.base_commit?.sha !== observedBaseSha
    || !Number.isInteger(comparison.behind_by)
    || comparison.behind_by < 0
  ) {
    return {
      state: 'error',
      description: `Comparison with protected ${protectedBase} ${observedBaseSha} is unavailable.`,
      stale: false,
    }
  }

  if (comparison.behind_by > 0) {
    return {
      state: 'failure',
      description: `Head is behind protected ${protectedBase} ${observedBaseSha} by ${comparison.behind_by} commit(s).`,
      stale: false,
    }
  }

  return {
    state: 'success',
    description: successDescription(protectedBase, observedBaseSha),
    stale: false,
  }
}

export async function runBranchFreshness({
  github,
  context,
  core,
  protectedBase = 'master',
  statusContext = 'branch-freshness',
}) {
  const statusTargetUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`

  async function protectedBaseSha() {
    const response = await github.rest.git.getRef({
      ...context.repo,
      ref: `heads/${protectedBase}`,
    })
    return requireSha(response.data?.object?.sha, 'Live protected base')
  }

  async function currentPull(number) {
    const response = await github.rest.pulls.get({
      ...context.repo,
      pull_number: number,
    })
    return response.data
  }

  async function publish(headSha, state, description) {
    await github.rest.repos.createCommitStatus({
      ...context.repo,
      sha: requireSha(headSha, 'Status head'),
      context: statusContext,
      state,
      description,
      target_url: statusTargetUrl,
    })
  }

  async function publishEnumerationError(error) {
    const message = error instanceof Error ? error.message : String(error)
    core.error(`Could not enumerate open pull requests: ${message}`)

    // A protected-base push has no pull-request head in its payload. Persist the
    // failed observation on the exact base event commit as well as failing the
    // workflow. Strict required-status enforcement keeps every older head
    // blocked until a later serialized run can recompute it.
    const eventBaseSha = context.payload?.after ?? context.sha
    try {
      await publish(
        eventBaseSha,
        'error',
        `Open pull requests for protected ${protectedBase} could not be enumerated.`,
      )
    } catch (publishError) {
      const publishMessage = publishError instanceof Error
        ? publishError.message
        : String(publishError)
      core.error(`Could not publish protected-base enumeration error: ${publishMessage}`)
    }
    core.setFailed('Open pull requests could not be enumerated for branch freshness.')
  }

  let pulls
  if (context.eventName === 'pull_request_target') {
    const pull = context.payload.pull_request
    pulls = Number.isInteger(pull?.number)
      ? [{ number: pull.number, headSha: pull.head?.sha }]
      : []
  } else {
    let openPulls
    try {
      openPulls = await github.paginate(github.rest.pulls.list, {
        ...context.repo,
        state: 'open',
        base: protectedBase,
        per_page: 100,
      })
    } catch (error) {
      await publishEnumerationError(error)
      return
    }
    pulls = openPulls.map((pull) => ({
      number: pull.number,
      headSha: pull.head?.sha,
    }))
  }

  let comparisonFailed = false
  const preparedPulls = []

  // Invalidate every previously successful status before doing any comparison.
  // This keeps the remaining heads non-successful if a base-push run times out
  // or is cancelled while processing a large set of open pull requests.
  const invalidations = await Promise.allSettled(pulls.map(async (candidate) => {
    const observedHeadSha = requireSha(candidate.headSha, `PR #${candidate.number} event head`)
    await publish(
      observedHeadSha,
      'pending',
      `Checking head against protected ${protectedBase}.`,
    )
    return { ...candidate, observedHeadSha }
  }))

  for (const [index, invalidation] of invalidations.entries()) {
    if (invalidation.status === 'fulfilled') {
      preparedPulls.push(invalidation.value)
    } else {
      comparisonFailed = true
      const message = invalidation.reason instanceof Error
        ? invalidation.reason.message
        : String(invalidation.reason)
      core.error(`PR #${pulls[index].number}: could not publish pending status: ${message}`)
    }
  }

  for (const candidate of preparedPulls) {
    let observedHeadSha = candidate.observedHeadSha
    let observedBaseSha

    try {
      const pull = await currentPull(candidate.number)
      if (pull.state !== 'open' || pull.base?.ref !== protectedBase) continue

      const liveHeadSha = requireSha(pull.head?.sha, `PR #${candidate.number} head`)
      if (liveHeadSha !== observedHeadSha) {
        observedHeadSha = liveHeadSha
        await publish(
          observedHeadSha,
          'pending',
          `Checking head against protected ${protectedBase}.`,
        )
      }
      observedBaseSha = await protectedBaseSha()

      await publish(
        observedHeadSha,
        'pending',
        `Checking head against protected ${protectedBase} ${observedBaseSha}.`,
      )
      const comparison = await github.rest.repos.compareCommitsWithBasehead({
        ...context.repo,
        basehead: `${observedBaseSha}...${observedHeadSha}`,
      })
      const [livePull, liveBaseSha] = await Promise.all([
        currentPull(candidate.number),
        protectedBaseSha(),
      ])
      const result = computeFreshnessStatus({
        comparison: comparison.data,
        protectedBase,
        observedHeadSha,
        observedBaseSha,
        liveHeadSha: livePull.head?.sha,
        liveBaseSha,
      })

      await publish(observedHeadSha, result.state, result.description)
      if (result.state === 'error') {
        comparisonFailed = true
        core.error(`PR #${candidate.number}: ${result.description}`)
      } else if (result.state === 'success') {
        // Close the publish/read race. The global workflow queue prevents another
        // writer from overtaking this run; if the repository changes during the
        // status API call, overwrite the transient success before completing.
        const [publishedPull, publishedBaseSha] = await Promise.all([
          currentPull(candidate.number),
          protectedBaseSha(),
        ])
        if (
          publishedPull.state !== 'open'
          || publishedPull.base?.ref !== protectedBase
          || publishedPull.head?.sha !== observedHeadSha
          || publishedBaseSha !== observedBaseSha
        ) {
          comparisonFailed = true
          await publish(
            observedHeadSha,
            'error',
            `Published comparison for protected ${protectedBase} ${observedBaseSha} became stale.`,
          )
          core.error(`PR #${candidate.number}: published comparison became stale.`)
        }
      }
    } catch (error) {
      comparisonFailed = true
      const message = error instanceof Error ? error.message : String(error)
      core.error(`PR #${candidate.number}: ${message}`)

      if (observedHeadSha) {
        try {
          await publish(
            observedHeadSha,
            'error',
            observedBaseSha
              ? `Comparison with protected ${protectedBase} ${observedBaseSha} is unavailable.`
              : `Comparison with protected ${protectedBase} is unavailable.`,
          )
        } catch (publishError) {
          const publishMessage = publishError instanceof Error ? publishError.message : String(publishError)
          core.error(`PR #${candidate.number}: could not publish error status: ${publishMessage}`)
        }
      }
    }
  }

  if (comparisonFailed) {
    core.setFailed('At least one branch freshness comparison was unavailable or stale.')
  }
}
