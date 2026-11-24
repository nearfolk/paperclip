// Ticket authority evaluator adapted from the company product release guard.
// Product release controls remain unchanged. Source checkout commit:
// 6eb2b9e55fb839607d75dc7f657d0354657546b4 (scripts/merge-pr.mjs).
const HOLD_MS = 5 * 60 * 1000
const SHA_PATTERN = /^[0-9a-f]{40}$/

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function timestamp(value, field) {
  const parsed = Date.parse(value ?? '')
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} did not provide an immutable createdAt timestamp`)
  }
  return parsed
}

function exactHeads(body) {
  if (typeof body !== 'string') return []

  const heads = []

  for (const match of body.matchAll(/[0-9a-f]{40}/gi)) {
    const start = match.index
    const end = start + match[0].length
    const previous = start > 0 ? body[start - 1] : ''
    const next = end < body.length ? body[end] : ''
    if (!/[0-9a-f]/i.test(previous) && !/[0-9a-f]/i.test(next)) {
      heads.push(match[0].toLowerCase())
    }
  }

  return heads
}

function includesHead(body, head) {
  if (!SHA_PATTERN.test(head ?? '')) return false
  return exactHeads(body).includes(head)
}

function pullRequestNumbers(body) {
  if (typeof body !== 'string') return []
  return [...new Set(
    [...body.matchAll(/\bPR\s*#([1-9]\d*)\b/gi)].map((match) => match[1]),
  )]
}

function isPass(body) {
  return (
    (
      /^\s*#{0,6}\s*PASS\b/im.test(body ?? '')
      || /\bverdict\s*:\s*PASS\b/i.test(body ?? '')
    )
    && !isPassRetraction(body)
  )
}

function isFail(body) {
  return (
    /^\s*#{0,6}\s*(?:FAIL|changes requested)\b/im.test(body ?? '')
    || /\bverdict\s*:\s*FAIL\b/i.test(body ?? '')
  )
}

function isFailRetraction(body) {
  return (
    /\bretract(?:s|ed|ion)?\b[^\n]{0,80}\b(?:FAIL|changes requested)\b/i.test(body ?? '')
    || /\b(?:FAIL|changes requested)\b[^\n]{0,80}\bretract(?:s|ed|ion)?\b/i.test(body ?? '')
  )
}

function isPassRetraction(body) {
  return (
    /\bretract(?:s|ed)?\b\s+(?:hereby\s+)?(?:(?:the|this|that|my|our|an?|earlier|prior|previous|current|latest|designated|QA)\s+){0,6}PASS\b/i.test(body ?? '')
    || /\bretraction\b\s+(?:of\s+)?(?:(?:the|this|that|my|our|an?|earlier|prior|previous|current|latest|designated|QA)\s+){0,6}PASS\b/i.test(body ?? '')
    || /(?:(?:the|this|that|my|our|an?|earlier|prior|previous|current|latest|designated|QA)\s+){0,6}PASS\b\s+(?:is|was|has\s+been|had\s+been|stands?)\s+(?:hereby\s+|now\s+)?retracted\b/i.test(body ?? '')
    || /^\s*#{0,6}\s*PASS\s+retraction\b/im.test(body ?? '')
    || /\bPASS\s+retraction\b\s+(?:for|of)\b/i.test(body ?? '')
  )
}

function recordsNoOtherVerdicts(body) {
  return /\b(?:no (?:other|additional) (?:team )?verdicts? (?:are )?(?:required|applicable)|other (?:team )?verdicts? (?:required|applicable):\s*none)\b/i
    .test(body ?? '')
}

function isPassAmendment(comment, reviewerId, passAtMs) {
  if (comment?.authorAgentId !== reviewerId) return false
  if (timestamp(comment.createdAt, 'Paperclip PASS amendment') <= passAtMs) return false
  if (!isPass(comment.body) || isFail(comment.body)) return false
  return /\bamend(?:ment|ed|s|ing)?\b/i.test(comment.body ?? '')
}

export function isClearance(body) {
  if (
    /\b(?:do not|cannot|must not|refuse to)\b[^\n]{0,40}\b(?:clear|lift|retract|resolve)(?:s|ed)?\b/i
      .test(body ?? '')
  ) {
    return false
  }
  return (
    /\b(?:hold|freeze)\b[^\n]{0,60}\b(?:clear|lift|retract|resolve)(?:s|ed)?\b/i.test(body ?? '')
    || /\b(?:clear|lift|retract|resolve)(?:s|ed)?\b[^\n]{0,60}\b(?:hold|freeze)\b/i.test(body ?? '')
  )
}

function normalizeClearanceDirectiveMarkdown(clause) {
  return String(clause ?? '').replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (link, label, target) => {
      const commentId = target.match(/#comment-([0-9a-z-]+)(?:[?#][^)]*)?$/i)?.[1]
      if (commentId) {
        const normalizedLabel = label.trim()
        return /\b(?:hold|freeze)\b/i.test(normalizedLabel)
          ? `${normalizedLabel} at comment \`${commentId}\``
          : `comment \`${commentId}\``
      }
      if (/^#\d+$/.test(label.trim())) return label.trim()
      return link
    },
  )
}

function isBoundedProtectedMergeClearanceClause(clause) {
  const bounded = normalizeClearanceDirectiveMarkdown(clause).trim().match(
    /^(?<directive>.+?)\s+(?<limit>(?:solely|exclusively)(?:\s+for)?|only\s+for|strictly\s+limited\s+to|limited\s+only\s+to)\s+(?<scope>.+)$/i,
  )
  if (!bounded?.groups || !isClearance(bounded.groups.directive)) return false

  const structuralRemainder = bounded.groups.directive
    .replace(/\bcomment\s+`[^`]+`/gi, 'comment')
    .replace(/\bcomment\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'comment')
    .replace(/[0-9a-f]{40}/gi, '')
    .replace(
      /\b(?:for|exact|head|sha|I|we|CEO|board|explicitly|hereby|clear|clears|cleared|lift|lifts|lifted|retract|retracts|retracted|resolve|resolves|resolved|and|only|the|original|earlier|prior|previous|hold|freeze|at|comment)\b/gi,
      '',
    )
    .replace(/[\s`#.,:;()\-]/g, '')
  if (structuralRemainder !== '') return false

  return /^protected\s+merge(?:\s+and\s+normal\s+dormant\s+deployment)?(?:(?:\s+of\s+PR\s*#\d+)?(?:\s+at\s+exact\s+head\s+`?[0-9a-f]{40}`?)?|\s+of\s+exact\s+PR\s*#\d+\s+head\s+`?[0-9a-f]{40}`?)[.;:]?$/i
    .test(bounded.groups.scope.trim())
}

function isExplicitDenyOnlyFollowOnClause(clause) {
  const normalized = clause
    .trim()
    .replace(/^\s*(?:(?:[-*+] |#{1,6}\s+|>\s+))+/, '')
    .trim()
  if (!normalized) return true

  if (/\b(?:authoriz(?:e|es|ed|ing|ation)|approv(?:e|es|ed|ing|al)|clear(?:s|ed|ing)?|lift(?:s|ed|ing)?|retract(?:s|ed|ing)?|resolv(?:e|es|ed|ing)|permit(?:s|ted|ting)?|allow(?:s|ed|ing)?|merg(?:e|es|ed|ing)|deploy(?:s|ed|ing|ment)?)\b/i.test(normalized)) {
    return false
  }
  if (/\b(?:but|except|however|although|though|while|whereas|unless|may|can|will|shall|should|proceed|ship|publish|send|execute|perform|trigger)\b/i.test(normalized)) {
    return false
  }

  return (
    /^(?:the\s+)?(?:(?:earlier|prior|previous)\s+)?(?:hold|freeze)\s+(?:remains?|stays?)\s+(?:(?:fully\s+)?active|in\s+(?:full\s+)?effect)(?:\s+for\b[^.!?;]*)?[.!?]?$/i.test(normalized)
    || /^Every\s+customer-facing\s+(?:hold|freeze)\s+(?:remains?|stays?)\s+(?:fully\s+)?active(?:,\s*including\b[^.!?;]*)?[.!?]?$/i.test(normalized)
  )
}

function isBoundedClearanceContextClause(clause) {
  const normalized = clause
    .trim()
    .replace(/^\s*(?:(?:[-*+] |#{1,6}\s+|>\s+))+/, '')
    .trim()
  if (!normalized) return true
  if (isExplicitDenyOnlyFollowOnClause(normalized)) return true

  return (
    /^(?:CEO\s+)?Post-PASS exact-head clearance\s+[—-]\s+protected repair only$/i.test(normalized)
    || /^This clearance is authored after the (?:valid|amended|fresh) same-author \[QA PASS\]\([^)]+#comment-[0-9a-z-]+\)[.!?]?$/i.test(normalized)
    || /^Any head or base change invalidates this clearance and requires the full gate again[.!?]?$/i.test(normalized)
    || /^Implementation remains delegated through \[[^\]]+\]\([^)]+\); [^.;!?]+ remains the same-author verdict seat on \[[^\]]+\]\([^)]+\), and [^.;!?]+ remains the distinct protected merge operator[.!?]?$/i.test(normalized)
    || /^\[@[^\]]+\]\(agent:\/\/[0-9a-f-]+\) may now restart the five-minute interval and rerun the exact-head protected verifier[.!?]?$/i.test(normalized)
    || /^\[@[^\]]+\]\(agent:\/\/[0-9a-f-]+\) remains the distinct protected merge operator and may restart the five-minute interval for this exact head[.!?]?$/i.test(normalized)
    || /^This decision (?:does not authorize|authorizes? no)\b[^.!?]*(?:[.!?])?$/i.test(normalized)
  )
}

function isBoundedProtectedMergeClearance(body, expectedHead) {
  const heads = [...new Set(exactHeads(body))]
  if (heads.length !== 1 || heads[0] !== expectedHead || !isClearance(body)) return false

  const clauses = String(body ?? '')
    .replaceAll('\\n', '\n')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
  const clearanceIndexes = clauses
    .map((clause, index) => isBoundedProtectedMergeClearanceClause(clause) ? index : -1)
    .filter((index) => index !== -1)
  if (clearanceIndexes.length !== 1) return false

  const clearanceIndex = clearanceIndexes[0]
  return clauses.every((clause, index) => (
    index === clearanceIndex || isBoundedClearanceContextClause(clause)
  ))
}

function isBoundedDescriptionDenialClearance(body, expectedHead, expectedOperatorId) {
  const heads = exactHeads(body)
  if (heads.length !== 1 || heads[0] !== expectedHead) return false

  const normalized = String(body ?? '').replaceAll('\\n', '\n')
  const clauses = normalized
    .split(/(?<=[.!?])\s+|\n+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
  if (clauses.length < 3) return false

  const operatorMatch = clauses[0].match(
    /^Executive CLEAR:\s+I\s+authorize\s+only\s+named\s+[^\n.]{1,100}\s+operator\s+`([0-9a-z-]+)`\s+to\s+perform\s+the\s+protected\s+merge\s+and\s+normal\s+deployment\s+of\s+PR\s*#\d+\s+at\s+exact\s+head\s+`([0-9a-f]{40})`\.$/i,
  )
  if (operatorMatch?.[1] !== expectedOperatorId || operatorMatch?.[2] !== expectedHead) return false

  const namedOperatorIds = [...normalized.matchAll(
    /\bnamed\b[^\n.!?]{0,100}\boperator\s+`([0-9a-z-]+)`/gi,
  )].map((match) => match[1])
  if (namedOperatorIds.some((operatorId) => operatorId !== expectedOperatorId)) return false

  const requiredClauses = [
    /^This clears the description-level do-not-merge wording solely for that exact head and operator\.$/i,
    /^Any head change or gate failure restores HOLD\.$/i,
  ]
  const optionalContext = [
    /^A fresh five-full-minute interval starts with this comment; after it elapses, the [^.;!?]+ must rerun the protected exact-head verifier and proceed only if every existing QA, security, branch-freshness, CI, protected-merge, and production-verification gate passes\.$/i,
  ]

  return requiredClauses.every((pattern) => clauses.some((clause) => pattern.test(clause)))
    && clauses.slice(1).every((clause) => (
      requiredClauses.some((pattern) => pattern.test(clause))
      || optionalContext.some((pattern) => pattern.test(clause))
    ))
}

function isBoundedUnavailableDenialClearance(body, expectedHead) {
  const heads = exactHeads(body)
  if (heads.length !== 1 || heads[0] !== expectedHead || !isClearance(body)) return false

  const normalized = String(body ?? '').replaceAll('\\n', '\n')
  const clauses = normalized
    .split(/(?<=[.!?])\s+|\n+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
  const clearanceClauses = clauses.filter((clause) => isClearance(clause))
  if (clearanceClauses.length !== 1) return false
  const clearanceClause = clearanceClauses[0]
  if (!clearanceClause) return false

  const hasAdditionalAuthorization = clauses.some((clause) => (
    clause !== clearanceClause
    && /\b(?:authoriz(?:e|es|ed|ing|ation)|approv(?:e|es|ed|ing|al)|permit(?:s|ted|ting)?|allow(?:s|ed|ing)?)\b/i.test(clause)
    && !/\b(?:no|not|never)\b[^.!?]{0,500}\b(?:authoriz(?:e|es|ed|ing|ation)|approv(?:e|es|ed|ing|al)|permit(?:s|ted|ting)?|allow(?:s|ed|ing)?)\b/i.test(clause)
    && !/\bunauthoriz(?:e|es|ed|ing|ation)\b/i.test(clause)
  ))
  if (hasAdditionalAuthorization) return false

  const bounded = clearanceClause.match(
    /\b(?:explicitly\s+)?(?:clear|lift|retract|resolve)(?:s|ed)?\b[^.!?]*(?:hold|denial)\b[^.!?]*\bsolely\s+for\s+(?<scope>[^.!?]+)[.!?]?$/i,
  )
  if (!bounded?.groups?.scope) return false

  return /^(?:named\s+[^.!?]{1,150}\s+to\s+use\s+)?the\s+protected(?:\s+admin\s+squash)?\s+merge\s+and\s+normal(?:\s+dormant)?\s+deployment(?:\s+path)?(?:\s+of\s+PR\s*#\d+)?(?:\s+at\s+exact\s+head\s+`?[0-9a-f]{40}`?)?(?:\s+by\s+named\s+[^.!?]{1,150})?$/i
    .test(bounded.groups.scope.trim())
}

function unavailableDenialClearanceTargetsSource(body, candidate) {
  const clearanceClause = String(body ?? '')
    .replaceAll('\\n', '\n')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((clause) => clause.trim())
    .find((clause) => isClearance(clause))
  if (!clearanceClause) return false

  if (candidate.source?.id) {
    return clearanceClause.includes(candidate.source.id)
  }

  if (!candidate.source?.sourceIssueId) return false
  if (/\bdescription-level\b[^.!?]*(?:do-not-merge|hold|denial)\b/i.test(clearanceClause)) {
    return true
  }

  return /\bancestor-scoped\s+HOLD\b/i.test(clearanceClause)
    && /\bancestor\b[^.!?]*\bscoped\s+HOLD\b/i.test(candidate.source?.body ?? '')
}

function explicitlyTargetsEarlierHold(body, holdSource) {
  if (!isClearance(body)) return false
  const clearanceClauses = String(body ?? '')
    .replaceAll('\\n', '\n')
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((clause) => isClearance(clause))
  const commentReferences = clearanceClauses.flatMap((clause) => [
    ...[...clause.matchAll(/\bcomment\s+`([^`]+)`/gi)].map((match) => match[1]),
    ...[...clause.matchAll(/\bcomment\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)]
      .map((match) => match[1]),
    ...[...clause.matchAll(/\]\([^)]+#comment-([0-9a-z-]+)(?:[?#][^)]*)?\)/gi)].map((match) => match[1]),
  ])
  if (commentReferences.length > 0) {
    const uniqueReferences = [...new Set(commentReferences)]
    return Boolean(
      holdSource?.id
      && uniqueReferences.length === 1
      && uniqueReferences[0] === holdSource.id,
    )
  }
  return /\b(?:earlier|prior|previous)\b[^\n]{0,40}\b(?:hold|freeze)\b/i.test(body ?? '')
}

function conversationalReleaseHold(body) {
  const normalized = String(body ?? '').replaceAll('\\n', '\n').trim()
  const conversationalHold = /\bhold\s*,?\s*(?:and\s+)?do\s+not\s+approve\s+yet\b/i
  const conversationalHoldParagraph = normalized
    .split(/\n\s*\n/)
    .find((paragraph) => conversationalHold.test(paragraph))
  return Boolean(
    conversationalHoldParagraph
    && (
      (
        conversationalHold.test(normalized.replace(/^\s*#{1,6}\s+[^\n]+\n+/, '').trim())
        && normalized.replace(/^\s*#{1,6}\s+[^\n]+\n+/, '').trim().split(/\s+/).length <= 10
      )
      || /\b(?:PR\s*#\d+|exact\s+head|merge|deploy(?:ment)?|release)\b/i.test(conversationalHoldParagraph)
    ),
  )
}

function withoutUnrelatedConversationalApprovalHold(body) {
  return String(body ?? '')
    .replaceAll('\\n', '\n')
    .split(/(\n\s*\n)/)
    .map((part) => (
      /\bhold\s*,?\s*(?:and\s+)?do\s+not\s+approve\s+yet\b/i.test(part)
      && !/\b(?:PR\s*#\d+|exact\s+head|merge|deploy(?:ment)?|release)\b/i.test(part)
        ? part.replace(/\bhold\s*,?\s*(?:and\s+)?do\s+not\s+approve\s+yet\b/gi, '')
        : part
    ))
    .join('')
}

export function isHold(body) {
  if (isClearance(body)) return false
  if (/\bno\b[^\n]{0,30}\b(?:open\s+)?(?:hold|freeze)\b/i.test(body ?? '')) return false
  return (
    /^\s*#{0,6}\s*(?:release\s+|merge\s+|gate\s+)?(?:HOLD|FREEZE|FROZEN)\b/im.test(body ?? '')
    || /\b(?:release|merge|gate)\s+(?:is\s+)?(?:on\s+)?(?:hold|frozen|freeze)\b/i.test(body ?? '')
    || conversationalReleaseHold(body)
  )
}

function releaseAuthorityRequirement(body, authorRole = null) {
  const lines = String(body ?? '').replaceAll('\\n', '\n').split('\n')
  const requirementIndex = lines.findIndex((line) => {
    if (!['ceo', 'board'].includes(authorRole) && !/\b(?:CEO|board)\b/i.test(line)) return false
    const normalized = line
      .replace(/^\s*(?:(?:[-*+] |\d+[.)] )|(?:#{1,6} )|(?:> ))+/, '')
      .trim()
    if (
      /^(?:verify|confirm|test|recognize|detect|match|parse|reproduce|describe|document|cover|preserve)\b/i.test(normalized)
      || /^(?:the\s+)?(?:test|regression|classifier|verifier|diagnostic|coverage|example|fixture|assertion|error|message|output)\b/i.test(normalized)
    ) {
      return false
    }
    if (/\b(?:no|not)\b[^\n]{0,80}\b(?:authoriz(?:ation|e|ed)|approv(?:al|e|ed))\b[^\n]{0,80}\brequir(?:e|es|ed)\b/i.test(line)) {
      return false
    }
    if (/\b(?:does|do)\s+not\s+require\b[^\n]{0,80}\b(?:authoriz(?:ation|e|ed)|approv(?:al|e|ed))\b/i.test(line)) {
      return false
    }

    return (
      /\b(?:authoriz(?:ation|e|ed)|approv(?:al|e|ed))\b[^\n]{0,60}\b(?:is\s+)?required\b[^\n]{0,80}\bbefore\b[^\n]{0,80}\b(?:release|merge|deploy|PR\s*#)\b/i.test(line)
      || /\b(?:do not|must not|cannot)\b[^\n]{0,40}\b(?:release|merge|deploy)\b[^\n]{0,100}\b(?:without|until)\b[^\n]{0,100}\b(?:authoriz(?:ation|e|ed|ing)|approv(?:al|e|ed|ing))\b/i.test(line)
      || /\bmust\b[^\n]{0,40}\b(?:obtain|receive|have)\b[^\n]{0,40}\b(?:authoriz(?:ation|e|ed)|approv(?:al|e|ed))\b[^\n]{0,80}\bbefore\b[^\n]{0,80}\b(?:release|merge|deploy|PR\s*#)\b/i.test(line)
      || /\b(?:new|fresh)\b[^\n]{0,160}\b(?:CEO|board)\b[^\n]{0,160}\b(?:go\/no-go|decision|authoriz(?:ation|e)|approv(?:al|e))\b[^\n]{0,80}\brequired\b[^\n]{0,160}\bbefore\b[^\n]{0,100}\b(?:release|merge|deploy|command)\b/i.test(line)
    )
  })
  if (requirementIndex === -1) return null
  const requirementLine = lines[requirementIndex]
  const namesCeo = /\bCEO\b/i.test(requirementLine)
  const namesBoard = /\bboard\b/i.test(requirementLine)
  const role = namesCeo && namesBoard
    ? 'ceo-or-board'
    : namesBoard || (!namesCeo && authorRole === 'board')
      ? 'board'
      : 'ceo'
  let scopedHeads = exactHeads(requirementLine)
  if (
    scopedHeads.length === 0
    && /\b(?:this|that|same|current|candidate)(?:\s+exact)?\s+(?:PR\s+)?(?:head|SHA)\b/i.test(requirementLine)
  ) {
    const contextLines = [
      ...lines.slice(0, requirementIndex).reverse(),
      ...lines.slice(requirementIndex + 1),
    ]
    const scopeLine = contextLines.find((line) => (
      /\b(?:exact(?:\s+40-character)?\s+(?:PR\s+)?head|(?:candidate|expected)\s+(?:head|SHA)|new\s+exact\s+candidate)\b/i.test(line)
      && exactHeads(line).length > 0
    ))
    if (scopeLine) scopedHeads = exactHeads(scopeLine).slice(0, 1)
  }
  return { role, scopedHeads }
}

function explicitlySupersedesImmediateMalformedComment(body) {
  return /\bsupersedes\s+the\s+immediately\s+preceding\s+malformed\s+formatting[- ]only\s+comment\b/i
    .test(body ?? '')
}

function supersededMalformedAuthoritySourceIds(sources, actorRoles) {
  const superseded = new Set()
  const timelinesByIssue = new Map()

  sources.forEach((source, inputIndex) => {
    const sourceIssueId = source?.sourceIssueId ?? source?.issueId
    const createdAtMs = Date.parse(source?.createdAt ?? '')
    if (!source?.id || !sourceIssueId || !Number.isFinite(createdAtMs)) return

    const timeline = timelinesByIssue.get(sourceIssueId) ?? []
    timeline.push({ source, createdAtMs, inputIndex })
    timelinesByIssue.set(sourceIssueId, timeline)
  })

  for (const timeline of timelinesByIssue.values()) {
    timeline.sort((left, right) => {
      const timestampOrder = left.createdAtMs - right.createdAtMs
      if (timestampOrder !== 0) return timestampOrder
      const leftId = String(left.source.id)
      const rightId = String(right.source.id)
      if (leftId !== rightId) return leftId < rightId ? -1 : 1
      return left.inputIndex - right.inputIndex
    })

    for (let index = 1; index < timeline.length; index += 1) {
      const correction = timeline[index].source
      const predecessor = timeline[index - 1].source
      if (
        timeline[index].createdAtMs <= timeline[index - 1].createdAtMs
        || !explicitlySupersedesImmediateMalformedComment(correction.body)
      ) {
        continue
      }

      const sameAuthenticatedAuthor = (
        typeof correction.authorAgentId === 'string'
        && correction.authorAgentId !== ''
        && correction.authorAgentId === predecessor.authorAgentId
        && typeof correction.createdByRunId === 'string'
        && correction.createdByRunId !== ''
        && correction.createdByRunId === predecessor.createdByRunId
      )
      if (!sameAuthenticatedAuthor) continue

      const authorRole = actorRoles.get(correction.authorAgentId) ?? null
      const malformedRequirement = releaseAuthorityRequirement(predecessor.body, authorRole)
      const correctedRequirement = releaseAuthorityRequirement(correction.body, authorRole)
      if (
        malformedRequirement?.scopedHeads.length === 0
        && exactHeads(predecessor.body).length === 0
        && !isReleaseDenial(predecessor.body)
        && !(isHold(predecessor.body) && ['ceo', 'board'].includes(authorRole))
        && !isReleaseAuthorization(predecessor.body)
        && correctedRequirement?.scopedHeads.length === 1
      ) {
        superseded.add(predecessor.id)
      }
    }
  }

  return superseded
}

function isReleaseAuthorization(body) {
  if (isReleaseDenial(body) || isHold(body)) return false
  return (
    /^\s*#{0,6}\s*(?:release\s+)?(?:AUTHORIZED|APPROVED)\b/im.test(body ?? '')
    || /\b(?:I|we|CEO|board)\s+(?:hereby\s+|explicitly\s+)?(?:authorize|approve)\b/i.test(body ?? '')
    || /\b(?:release|merge|deployment)\s+(?:is\s+)?(?:authorized|approved)\b/i.test(body ?? '')
    || /\b(?:authorization|approval)\s*:\s*(?:granted|approved)\b/i.test(body ?? '')
    || /\b(?:merge|release)\s+authority\b[^\n]{0,80}\b(?:restored|reinstated|granted)\b/i.test(body ?? '')
    || /\b(?:clear|clearance|cleared)\b[^\n]{0,80}\b(?:merge|release)\b/i.test(body ?? '')
  )
}

function withoutGithubOnlyReviewRestriction(body) {
  const githubReviewRestriction = /\b(?:(?:do|does|did)\s+not|must\s+not|cannot|never)\s+(?:approve\s+on\s+GitHub|submit\s+(?:an?\s+|any\s+)?(?:approving\s+)?GitHub\s+(?:approval|review))\b/gi

  return String(body ?? '').replace(
    /[^.!?\n]*(?:\b(?:(?:do|does|did)\s+not|must\s+not|cannot|never)\s+(?:approve\s+on\s+GitHub|submit\s+(?:an?\s+|any\s+)?(?:approving\s+)?GitHub\s+(?:approval|review))\b)[^.!?\n]*[.!?]?/gi,
    (clause) => {
      const remainingScope = clause
        .replace(githubReviewRestriction, '')
        .replace(/\brelease\s+(?:any\s+)?HOLDs?\b/gi, '')

      if (/\b(?:merge|deploy(?:ment)?|release)\b/i.test(remainingScope)) return clause
      return clause.replace(githubReviewRestriction, '')
    },
  )
}

function isReleaseDenial(body) {
  const releaseScopedBody = withoutGithubOnlyReviewRestriction(
    withoutUnrelatedConversationalApprovalHold(body),
  )
    .replace(
      /\bdo not approve or publish on UNKNOWN\/FAIL\.(?=\s|$)/gi,
      '',
    )

  return (
    /^\s*#{0,6}\s*(?:release\s+)?(?:DENIED|NOT AUTHORIZED)\b/im.test(releaseScopedBody)
    || /\b(?:do not|cannot|refuse to)\s+(?:authorize|approve)\b/i.test(releaseScopedBody)
    || /\b(?:authorization|approval)\s+(?:is\s+)?(?:denied|withheld|refused)\b/i.test(releaseScopedBody)
    || /\bno\s+(?:merge|release)\s+authority\b/i.test(releaseScopedBody)
    || /\b(?:merge|release)\s+authority\b[^\n]{0,80}\b(?:withheld|revoked|void|withdrawn)\b/i.test(releaseScopedBody)
    || /\b(?:withhold|revoke|void|withdraw)\b[^\n]{0,80}\b(?:merge|release)\s+authority\b/i.test(releaseScopedBody)
  )
}

function isReviewerOnlyDescriptionDenial(body) {
  if (!isReleaseDenial(body)) return false
  const withoutTargetedBoundary = String(body ?? '').replace(
    /\bdo not approve(?:\s+on\s+GitHub)?(?:\s*,\s*[^.\n,]+)*\s*,?\s+or\s+merge\s+as\s+(?:the\s+)?reviewer\b/gi,
    '',
  )
  return !isReleaseDenial(withoutTargetedBoundary)
}

function withoutFactualStaleVerdictNonAuthorization(body) {
  const withoutQuotedDiagnosticExamples = String(body ?? '')
    .split('\n')
    .map((line) => (
      /\b(?:QA|diagnostic|test|regression|fixture|example|parser|classifier|verifier)\b/i.test(line)
        ? line.replace(/`[^`]*(?:do not|cannot|refuse to)\s+(?:authorize|approve)[^`]*`/gi, '')
        : line
    ))
    .join('\n')

  return withoutQuotedDiagnosticExamples
    .replace(
      /an authenticated current-head `Do not approve or publish the release\.\.\.` directive remains fail-closed\.?/gi,
      '',
    )
    .replace(
      /\b(?:earlier|prior|previous)\b[^\n]{0,80}\b(?:QA\s+)?PASS\b[^\n]{0,100}\b(?:is|was)\s+(?:now\s+)?(?:stale|obsolete|superseded)\b[^\n.;:]{0,60}\band\s+cannot\s+authorize\s+(?:the\s+)?(?:merge|release|deployment)\b/gi,
      '',
    )
    .replace(
      /\bevery\s+(?:(?:QA\s+)?PASS|(?:QA\s+)?verdict)\s+for\s+(?:an?|the)\s+(?:earlier|prior|previous|old)\s+(?:exact\s+)?head\b[^\n.;:]{0,80}\b(?:is|was)\s+(?:now\s+)?(?:stale|obsolete|superseded)\b[^\n.;:]{0,60}\band\s+cannot\s+authorize\s+(?:the\s+)?(?:merge|release|deployment)\b/gi,
      '',
    )
}

function explicitlyCitesComment(body, commentId) {
  if (typeof commentId !== 'string' || commentId === '') return false
  const escapedId = regexEscape(commentId)
  return (
    new RegExp(`\\bcomment\\s+\`?${escapedId}\`?(?![0-9a-z-])`, 'i').test(body ?? '')
    || new RegExp(`#comment-${escapedId}(?![0-9a-z-])`, 'i').test(body ?? '')
  )
}

function retractedQaFailureSourceIds(sources, expectedHead, reviewerId, passAtMs) {
  const failures = sources.filter((source) => (
    typeof source?.id === 'string'
    && source.id !== ''
    && source.authorAgentId === reviewerId
    && isFail(source.body)
    && !isFailRetraction(source.body)
    && includesHead(source.body, expectedHead)
  ))
  const retracted = new Set()

  for (const retraction of sources) {
    const retractionHeads = [...new Set(exactHeads(retraction?.body))]
    if (
      retraction?.authorAgentId !== reviewerId
      || !isFailRetraction(retraction?.body)
      || retractionHeads.length !== 1
      || retractionHeads[0] !== expectedHead
    ) {
      continue
    }

    const retractionAtMs = Date.parse(retraction?.createdAt ?? '')
    if (!Number.isFinite(retractionAtMs) || retractionAtMs >= passAtMs) continue
    const citedFailures = failures.filter((failure) => (
      (failure.sourceIssueId ?? failure.issueId) === (retraction.sourceIssueId ?? retraction.issueId)
      && Date.parse(failure.createdAt ?? '') < retractionAtMs
      && explicitlyCitesComment(retraction.body, failure.id)
    ))
    if (citedFailures.length === 1) retracted.add(citedFailures[0].id)
  }

  return retracted
}

function withoutRetractedQaFailureEffect(body) {
  return String(body ?? '')
    .replace(
      /\b(?:those|these|such|the)\s+(?:records|verdicts|comments|results|checks|artifacts|gates|evidence)\b[^.!?\n]{0,160}\bcannot\s+authorize\s+(?:this|the)\s+(?:head|merge|release|deployment)\b[^.!?\n]*[.!?]?/gi,
      '',
    )
    .replace(
      /\bNo\b[^.!?\n]{0,300}\b(?:was|were|has\s+been|have\s+been)\s+(?:performed|submitted|executed|attempted|made|run|triggered|sent|published|deployed|merged|released)\b[^.!?\n]*[.!?]?/gi,
      '',
    )
}

function authoritySourceLabel(source) {
  if (source?.sourceKind === 'board_only_clearance' && source?.id) {
    return `interaction ${source.id}`
  }
  if (source?.id) return `comment ${source.id}`
  if (source?.sourceIssueId) return `issue ${source.sourceIssueId} description`
  return 'QA ticket description'
}

function normalizedInteractionText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function regexEscape(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function boardOnlyDescriptionClearance(interaction, issue, authorityScope, expectedHead) {
  if (
    !isRecord(interaction)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(interaction.id ?? '')
    || interaction.issueId !== issue.id
    || interaction.kind !== 'request_confirmation'
    || interaction.status !== 'accepted'
    || interaction.requestedResolverPolicy !== 'board_only'
    || interaction.effectiveResolverPolicy !== 'board_only'
    || interaction.resolverPolicy !== 'board_only'
    || interaction.result?.version !== 1
    || interaction.result?.outcome !== 'accepted'
    || interaction.createdByAgentId !== issue.assigneeAgentId
    || typeof interaction.resolvedByUserId !== 'string'
    || interaction.resolvedByUserId.trim() === ''
    || interaction.resolvedByAgentId != null
    || interaction.payload?.version !== 1
    || interaction.payload?.target?.type !== 'custom'
    || interaction.payload?.target?.revisionId !== expectedHead
  ) {
    return null
  }

  const createdAtMs = Date.parse(interaction.createdAt ?? '')
  const resolvedAtMs = Date.parse(interaction.resolvedAt ?? '')
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(resolvedAtMs) || resolvedAtMs < createdAtMs) {
    return null
  }

  const prompt = normalizedInteractionText(interaction.payload.prompt)
  const details = normalizedInteractionText(interaction.payload.detailsMarkdown)
  const issueIdentifier = regexEscape(issue.identifier)
  const head = regexEscape(expectedHead)
  const promptMatch = prompt.match(new RegExp(
    `^Does the CEO/board explicitly clear ${issueIdentifier}[’']s description-level reviewer merge denial for exact head ${head} solely so distinct [A-Za-z][A-Za-z -]* merge operator (?<operator>[0-9A-Za-z-]+) may use npm run merge:pr\\?$`,
    'i',
  ))
  const detailsMatch = details.match(
    /^This clearance is limited to the protected merge and normal dormant deployment for PR #(?<pr>[1-9]\d*) at the named exact head\. It does not authorize publication, email, social, browsing, release of the (?<hold>LIV-[1-9]\d*) hold, or any other customer-facing action\.$/i,
  )
  const issuePrNumbers = pullRequestNumbers(issue.description)
  const governingHold = detailsMatch?.groups
    ? authorityScope.find((source) => (
        source?.sourceKind === 'issue_description'
        && source.sourceIssueIdentifier?.toUpperCase() === detailsMatch.groups.hold.toUpperCase()
        && /\bHOLD\b/i.test(source.body ?? '')
        && /\bpublication\b/i.test(source.body ?? '')
        && /\bemail\b/i.test(source.body ?? '')
      ))
    : null
  if (
    !promptMatch?.groups
    || promptMatch.groups.operator !== issue.assigneeAgentId
    || !detailsMatch?.groups
    || issuePrNumbers.length !== 1
    || detailsMatch.groups.pr !== issuePrNumbers[0]
    || interaction.payload.target.key !== `pr-${detailsMatch.groups.pr}-exact-head-merge-clearance`
    || !governingHold
  ) {
    return null
  }

  const mentionedHeads = [...new Set(exactHeads(`${prompt}\n${details}`))]
  if (mentionedHeads.length !== 1 || mentionedHeads[0] !== expectedHead) return null

  return {
    ...interaction,
    body: `${prompt}\n${details}`,
    authorAgentId: null,
    createdAt: interaction.resolvedAt,
    sourceIssueId: issue.id,
    sourceKind: 'board_only_clearance',
    targetIssueDescriptionId: issue.id,
  }
}

function mergeRequiredAuthorityRole(current, incoming) {
  if (!incoming) return current
  if (!current || current === incoming) return incoming
  if (current === 'ceo-or-board' && ['ceo', 'board'].includes(incoming)) return incoming
  if (incoming === 'ceo-or-board' && ['ceo', 'board'].includes(current)) return current
  throw new Error('Conflicting ticket-scoped release-authority requirements')
}

function authorityRoleMatches(requiredRole, actorRole) {
  return requiredRole === actorRole
    || (requiredRole === 'ceo-or-board' && ['ceo', 'board'].includes(actorRole))
}

function authorityRoleLabel(role) {
  return role === 'ceo-or-board' ? 'CEO/board' : role.toUpperCase()
}

function evaluateReleaseAuthority({
  issue,
  orderedComments,
  interactions,
  authorityScope,
  actorRoles,
  expectedHead,
  operatorId,
  reviewerId,
  passAtMs,
}) {
  const boardOnlyClearances = interactions
    .map((interaction) => boardOnlyDescriptionClearance(interaction, issue, authorityScope, expectedHead))
    .filter(Boolean)
  const sources = [
    {
      body: issue.description,
      authorAgentId: issue.createdByAgentId,
      createdAt: issue.createdAt,
      sourceIssueId: issue.id,
      sourceKind: 'issue_description',
    },
    ...orderedComments,
    ...authorityScope,
    ...boardOnlyClearances,
  ]
  const supersededSourceIds = supersededMalformedAuthoritySourceIds(sources, actorRoles)
  const retractedQaFailureIds = retractedQaFailureSourceIds(
    sources,
    expectedHead,
    reviewerId,
    passAtMs,
  )
  const directives = sources.flatMap((source, index) => {
    if (supersededSourceIds.has(source?.id)) return []
    const targetedBoardOnlyClearance = source?.sourceKind === 'board_only_clearance'
    const authorRole = targetedBoardOnlyClearance
      ? 'board'
      : actorRoles.get(source?.authorAgentId) ?? null
    const requirement = releaseAuthorityRequirement(source?.body, authorRole)
    let requiredRole = requirement?.role ?? null
    if (
      requirement?.scopedHeads.length > 0
      && !requirement.scopedHeads.includes(expectedHead)
    ) {
      requiredRole = null
    }
    const sourceBody = retractedQaFailureIds.has(source?.id)
      ? withoutRetractedQaFailureEffect(source?.body)
      : source?.body
    const denialBody = ['ceo', 'board'].includes(authorRole)
      ? sourceBody
      : withoutFactualStaleVerdictNonAuthorization(sourceBody)
    const holdDenial = isHold(source?.body) && (
      ['ceo', 'board'].includes(authorRole)
      || retractedQaFailureIds.has(source?.id)
    )
    const denial = isReleaseDenial(denialBody) || holdDenial
    const boundedHoldClearance = authorRole === 'ceo'
      && isBoundedProtectedMergeClearance(source?.body, expectedHead)
    const boundedDescriptionClearance = authorRole === 'ceo'
      && isBoundedDescriptionDenialClearance(source?.body, expectedHead, operatorId)
    const boundedUnavailableDenialClearance = authorRole === 'ceo'
      && isBoundedUnavailableDenialClearance(source?.body, expectedHead)
    if (boundedDescriptionClearance || boundedUnavailableDenialClearance) {
      requiredRole = mergeRequiredAuthorityRole(requiredRole, 'ceo')
    }
    const authorization = isReleaseAuthorization(source?.body)
      || boundedHoldClearance
      || boundedDescriptionClearance
      || boundedUnavailableDenialClearance
      || targetedBoardOnlyClearance
    if (!requiredRole && !denial && !authorization) return []

    const scopedHeads = exactHeads(source?.body)
    if (denial && scopedHeads.length > 0 && !scopedHeads.includes(expectedHead)) {
      return []
    }

    return [{
      source,
      index,
      authorRole,
      requiredRole,
      denial,
      holdDenial,
      authorization,
      boundedHoldClearance,
      targetedBoardOnlyClearance,
      boundedDescriptionClearance,
      boundedUnavailableDenialClearance,
      createdAtMs: timestamp(source?.createdAt, `Paperclip authority source ${authoritySourceLabel(source)}`),
    }]
  }).sort((left, right) => left.createdAtMs - right.createdAtMs || left.index - right.index)

  let requiredRole = null
  let denial = null
  let releaseAuthority = null
  let ambiguousDenials = []
  let unavailableActorDenials = []

  for (const directive of directives) {
    requiredRole = mergeRequiredAuthorityRole(requiredRole, directive.requiredRole)

    if (directive.denial) {
      const laterBoardClearanceTargetsDescription = boardOnlyClearances.some((clearance) => (
        directive.source?.sourceKind === 'issue_description'
        && clearance.targetIssueDescriptionId === directive.source.sourceIssueId
        && isReviewerOnlyDescriptionDenial(directive.source.body)
        && timestamp(clearance.createdAt, 'Paperclip board-only clearance') > directive.createdAtMs
      ))
      const denyingRole = laterBoardClearanceTargetsDescription
        ? 'board'
        : ['ceo', 'board'].includes(directive.authorRole)
        ? directive.authorRole
        : directive.requiredRole
      if (!denyingRole) {
        unavailableActorDenials.push(directive)
        denial = directive
        releaseAuthority = null
        continue
      }
      requiredRole = mergeRequiredAuthorityRole(requiredRole, denyingRole)
      if (!includesHead(directive.source.body, expectedHead)) {
        ambiguousDenials.push(directive)
      }
      denial = directive
      releaseAuthority = null
      continue
    }

    if (directive.requiredRole && releaseAuthority) {
      releaseAuthority = null
    }
    if (
      directive.authorization
      && requiredRole
      && authorityRoleMatches(requiredRole, directive.authorRole)
      && includesHead(directive.source.body, expectedHead)
      && directive.createdAtMs > passAtMs
      && (!denial || directive.createdAtMs > denial.createdAtMs)
    ) {
      if (
        directive.targetedBoardOnlyClearance
        && (
          !denial
          || denial.source?.sourceKind !== 'issue_description'
          || denial.source.sourceIssueId !== directive.source.targetIssueDescriptionId
        )
      ) {
        continue
      }
      if (unavailableActorDenials.length > 0) {
        if (!directive.boundedDescriptionClearance && !directive.boundedUnavailableDenialClearance) continue
        const explicitlyTargeted = unavailableActorDenials.filter((candidate) => (
          candidate.createdAtMs < directive.createdAtMs
          && (
            (
              directive.boundedDescriptionClearance
              && !candidate.source?.id
              && candidate.source?.sourceIssueId === issue.id
            )
            || (
              (candidate.source?.id || candidate.source?.sourceIssueId === issue.id)
              && unavailableDenialClearanceTargetsSource(directive.source.body, candidate)
            )
          )
        ))
        if (explicitlyTargeted.length !== 1) continue
        const targeted = new Set(explicitlyTargeted)
        unavailableActorDenials = unavailableActorDenials.filter((candidate) => !targeted.has(candidate))
        if (unavailableActorDenials.length > 0) continue
      }
      if (ambiguousDenials.length > 0) {
        if (!directive.boundedHoldClearance) continue
        const explicitlyTargeted = ambiguousDenials.filter((candidate) => (
          candidate.createdAtMs < directive.createdAtMs
          && explicitlyTargetsEarlierHold(directive.source.body, candidate.source)
        ))
        if (explicitlyTargeted.length === 0) continue
        if (explicitlyTargeted.length > 1 && !explicitlyTargeted.every((candidate) => (
          candidate.source?.id && String(directive.source.body ?? '').includes(candidate.source.id)
        ))) {
          continue
        }
        const targeted = new Set(explicitlyTargeted)
        ambiguousDenials = ambiguousDenials.filter((candidate) => !targeted.has(candidate))
        if (ambiguousDenials.length > 0) continue
      }
      releaseAuthority = directive
      denial = null
    }
  }

  if (unavailableActorDenials.length > 0) {
    const unresolved = unavailableActorDenials.at(-1)
    throw new Error(
      `Ticket-scoped merge denial actor authority is unavailable at ${authoritySourceLabel(unresolved.source)}`,
    )
  }
  if (ambiguousDenials.length > 0) {
    const unresolved = ambiguousDenials.at(-1)
    throw new Error(
      `Ticket-scoped merge denial has ambiguous exact-head scope at ${authoritySourceLabel(unresolved.source)}`,
    )
  }
  if (denial) {
    throw new Error(
      `Required release authority denied or held release in ${authoritySourceLabel(denial.source)}`,
    )
  }
  if (requiredRole && !releaseAuthority) {
    throw new Error(`Required ${authorityRoleLabel(requiredRole)} exact-head release authorization is absent`)
  }

  return {
    releaseAuthority: releaseAuthority
      ? {
          role: requiredRole,
          actorId: releaseAuthority.source.authorAgentId
            ?? releaseAuthority.source.resolvedByUserId
            ?? null,
          comment: releaseAuthority.source,
        }
      : null,
    restartAtMs: releaseAuthority ? releaseAuthority.createdAtMs : passAtMs,
  }
}

function sortedComments(comments) {
  if (!Array.isArray(comments)) {
    throw new Error('Paperclip comment history is unavailable')
  }
  return [...comments].sort(
    (left, right) => timestamp(left.createdAt, 'Paperclip comment') - timestamp(right.createdAt, 'Paperclip comment'),
  )
}

function matchingHandoffs(activity, operatorId) {
  if (!Array.isArray(activity)) {
    throw new Error('Paperclip assignment history is unavailable')
  }

  return activity.filter((event) => {
    const details = event?.details
    const previous = details?._previous?.assigneeAgentId
    return (
      event?.action === 'issue.updated'
      && details?.assigneeAgentId === operatorId
      && typeof previous === 'string'
      && previous !== operatorId
    )
  })
}

function activeHoldAfter(comments, startMs) {
  let hold = null
  let restartAtMs = startMs

  for (const comment of comments) {
    const createdAtMs = timestamp(comment.createdAt, 'Paperclip comment')
    if (createdAtMs <= startMs) continue
    if (isClearance(comment.body)) {
      if (hold) {
        hold = null
        restartAtMs = createdAtMs
      }
      continue
    }
    if (isHold(comment.body)) {
      hold = comment
    }
  }

  return { hold, restartAtMs }
}

export function evaluateQaTicket({
  issue,
  comments,
  activity,
  interactions,
  authorityScope,
  expectedHead,
  operatorId,
  nowMs,
  authorityActors = [],
}) {
  if (!isRecord(issue)) throw new Error('Paperclip QA ticket is unavailable')
  if (!Array.isArray(authorityScope)) {
    throw new Error('Paperclip QA ticket ancestor scope and history are unavailable')
  }
  if (!Array.isArray(interactions)) {
    throw new Error('Paperclip QA ticket interaction history is unavailable')
  }
  if (!Array.isArray(authorityActors)) {
    throw new Error('Paperclip release-authority identity data is unavailable')
  }
  if (!SHA_PATTERN.test(expectedHead ?? '')) throw new Error('Expected head must be a 40-character SHA')
  if (issue.assigneeAgentId !== operatorId) {
    throw new Error('QA ticket is not assigned to the authenticated merge operator')
  }
  if (!['in_review', 'in_progress'].includes(issue.status)) {
    throw new Error(`QA ticket must be in review or in progress, not ${issue.status ?? 'unknown'}`)
  }

  const ordered = sortedComments(comments)
  const candidates = []

  for (const handoff of matchingHandoffs(activity, operatorId)) {
    const reviewerId = handoff.details._previous.assigneeAgentId
    const handoffAtMs = timestamp(handoff.createdAt, 'Paperclip handoff')
    const pass = ordered.filter((comment) => (
      comment.authorAgentId === reviewerId
      && timestamp(comment.createdAt, 'Paperclip PASS') <= handoffAtMs
      && includesHead(comment.body, expectedHead)
      && isPass(comment.body)
    )).at(-1)
    if (pass) candidates.push({ handoff, pass, reviewerId })
  }

  if (candidates.length === 0) {
    throw new Error('No designated-reviewer PASS and operator handoff match the expected head')
  }

  const selected = candidates.sort(
    (left, right) => timestamp(right.pass.createdAt, 'Paperclip PASS') - timestamp(left.pass.createdAt, 'Paperclip PASS'),
  )[0]
  const passAtMs = timestamp(selected.pass.createdAt, 'Paperclip PASS')

  const reviewerComments = ordered.filter(
    (comment) => comment.authorAgentId === selected.reviewerId,
  )
  const retractedReviewerFailureIds = retractedQaFailureSourceIds(
    reviewerComments.map((comment) => ({
      ...comment,
      sourceIssueId: issue.id,
    })),
    expectedHead,
    selected.reviewerId,
    passAtMs,
  )
  const passRetraction = reviewerComments.find(
    (comment) => (
      timestamp(comment.createdAt, 'Paperclip comment') > passAtMs
      && isPassRetraction(comment.body)
      && includesHead(comment.body, expectedHead)
    ),
  )
  if (passRetraction) {
    throw new Error(`Designated QA PASS was retracted by comment ${passRetraction.id ?? 'unknown'}`)
  }

  for (const failure of reviewerComments.filter((comment) => (
    isFail(comment.body)
    && !isFailRetraction(comment.body)
    && includesHead(comment.body, expectedHead)
  ))) {
    const failureAtMs = timestamp(failure.createdAt, 'Paperclip FAIL')
    if (failureAtMs >= passAtMs) {
      throw new Error(`Designated QA has a later FAIL at ${failure.createdAt}`)
    }
    if (!retractedReviewerFailureIds.has(failure.id)) {
      throw new Error(`Designated QA has an unretracted FAIL from ${failure.createdAt}`)
    }
  }

  const passAmendments = reviewerComments.filter((comment) => (
    isPassAmendment(comment, selected.reviewerId, passAtMs)
  ))
  for (const amendment of passAmendments) {
    const amendmentHeads = [...new Set(exactHeads(amendment.body))]
    if (amendmentHeads.includes(expectedHead) && amendmentHeads.length !== 1) {
      throw new Error(`Designated QA PASS amendment has ambiguous exact-head scope at comment ${amendment.id ?? 'unknown'}`)
    }
  }
  const latestSameHeadAmendment = passAmendments.filter((comment) => {
    const amendmentHeads = [...new Set(exactHeads(comment.body))]
    return amendmentHeads.length === 1 && amendmentHeads[0] === expectedHead
  }).at(-1) ?? null
  const passAmendment = latestSameHeadAmendment && recordsNoOtherVerdicts(latestSameHeadAmendment.body)
    ? latestSameHeadAmendment
    : null
  const declarationAtMs = recordsNoOtherVerdicts(selected.pass.body)
    ? passAtMs
    : passAmendment
      ? timestamp(passAmendment.createdAt, 'Paperclip PASS amendment')
      : passAtMs

  const actorRoles = new Map(
    authorityActors
      .filter((actor) => actor?.id && typeof actor?.role === 'string')
      .map((actor) => [actor.id, actor.role.toLowerCase()]),
  )
  const authority = evaluateReleaseAuthority({
    issue,
    orderedComments: ordered,
    interactions,
    authorityScope,
    actorRoles,
    expectedHead,
    operatorId,
    reviewerId: selected.reviewerId,
    passAtMs,
  })

  const { hold, restartAtMs } = activeHoldAfter(ordered, passAtMs)
  if (hold) {
    throw new Error(`QA ticket has an open release hold from ${hold.createdAt}`)
  }

  const eligibleAtMs = Math.max(restartAtMs, authority.restartAtMs, declarationAtMs) + HOLD_MS
  if (!Number.isFinite(nowMs)) throw new Error('Current time is unavailable')
  if (nowMs < eligibleAtMs) {
    const seconds = Math.ceil((eligibleAtMs - nowMs) / 1000)
    throw new Error(`Five-minute post-QA hold has ${seconds} second(s) remaining`)
  }

  return {
    reviewerId: selected.reviewerId,
    operatorId,
    passComment: selected.pass,
    passAt: selected.pass.createdAt,
    passAmendmentComment: passAmendment,
    eligibleAt: new Date(eligibleAtMs).toISOString(),
    releaseAuthority: authority.releaseAuthority,
    noOtherVerdictsRecorded: recordsNoOtherVerdicts(selected.pass.body) || Boolean(passAmendment),
  }
}

export function evaluateRequiredVerdict({ issue, comments, expectedHead }) {
  if (!isRecord(issue)) throw new Error('Required verdict ticket is unavailable')
  const ordered = sortedComments(comments)
  const matching = ordered.filter(
    (comment) => includesHead(comment.body, expectedHead) && (isPass(comment.body) || isFail(comment.body)),
  )
  const latest = matching.at(-1)
  if (!latest || !isPass(latest.body)) {
    throw new Error(`${issue.identifier ?? 'Required ticket'} lacks a current exact-head PASS`)
  }
  const later = ordered.filter(
    (comment) => timestamp(comment.createdAt, 'Required verdict comment') > timestamp(latest.createdAt, 'Required PASS'),
  )
  if (later.some((comment) => (
    isHold(comment.body)
    || (
      includesHead(comment.body, expectedHead)
      && (isPassRetraction(comment.body) || isFail(comment.body))
    )
  ))) {
    throw new Error(`${issue.identifier ?? 'Required ticket'} has a later retraction, FAIL, or hold`)
  }
  return { identifier: issue.identifier, passComment: latest }
}
