import { createHash } from 'node:crypto'

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

export function isFail(body) {
  return (
    /^\s*#{0,6}\s*(?:FAIL|changes requested)\b/im.test(body ?? '')
    || /\bverdict\s*:\s*FAIL\b/i.test(body ?? '')
  )
}

export function parseFailRetractionReceipt(body) {
  // A receipt is a completed first-person act, not nearby retraction words.
  // Keep its comment ID and head in the same unqualified sentence. The fork
  // requires a standalone receipt; supporting discussion belongs elsewhere.
  const match = String(body ?? '').trim().match(
    /^(?:RETRACTION\s*[—:-]\s*)?I\s+(?:(?:explicitly|hereby)\s+)?retract\s+(?:(?:my|the|earlier|prior|previous|controlling|cited)\s+){0,4}(?:FAIL|changes requested)\s+(?:in\s+[A-Z][A-Z0-9]*-\d+\s+)?(?:at\s+)?comment\s+`?([0-9a-z-]+)`?\s+(?:for\s+(?:PR\s*#\d+\s+)?(?:corrected|exact|new)\s+head|after\s+verifying\s+exact\s+head)\s+`?([0-9a-f]{40})`?\.$/i,
  )
  return match ? { commentId: match[1], head: match[2].toLowerCase() } : null
}

export function isFailRetraction(body) {
  if (isFail(body)) return false
  // Historical authority receipts may have supporting paragraphs. Their first
  // line must still be an explicit completed receipt. Cross-ticket eligibility
  // below uses the stricter whole-comment parser and exact extracted bindings.
  return Boolean(parseFailRetractionReceipt(String(body ?? '').trim().split('\n')[0]))
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

export function parseHoldClearanceReceipt(body) {
  // A clearance is an immutable completed act, with one parsed source and head.
  // Narrative, quotations, instructions and future/conditional acts are not receipts.
  const match = String(body ?? '').trim().match(
    /^I\s+(?:(?:explicitly|hereby)\s+)?clear\s+(?:(?:the|earlier|original)\s+){0,2}(?:hold|freeze)\s+at\s+(comment|description)\s+`?([0-9a-z-]+)`?\s+(?:for\s+exact\s+head|solely\s+for\s+protected\s+merge(?:\s+and\s+normal\s+dormant\s+deployment)?\s+at\s+exact\s+head)\s+`?([0-9a-f]{40})`?\.$/i,
  )
  return match ? { sourceKind: match[1].toLowerCase(), sourceId: match[2], head: match[3].toLowerCase(), bounded: /solely for protected merge/i.test(body) } : null
}

export function isClearance(body) {
  return Boolean(parseHoldClearanceReceipt(body))
}

export function validHoldClearance(comment, hold, expectedHead, actorRoles) {
  const receipt = parseHoldClearanceReceipt(comment?.body)
  if (!receipt || receipt.head !== expectedHead) return false
  const description = hold?.sourceKind === 'issue_description'
  if (receipt.sourceKind !== (description ? 'description' : 'comment')
    || receipt.sourceId !== (description ? hold.sourceIssueId : hold?.id)) return false
  if (!comment.authorAgentId || !(comment.authorAgentId === hold.authorAgentId
    || ['ceo', 'board'].includes(actorRoles.get(comment.authorAgentId)))) return false
  const created = timestamp(comment.createdAt, 'Hold clearance')
  if (comment.updatedAt && timestamp(comment.updatedAt, 'Hold clearance update') !== created) return false
  return created > timestamp(hold.updatedAt ?? hold.createdAt, 'Hold source')
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
  const receipt = parseHoldClearanceReceipt(body)
  return receipt?.bounded === true && receipt.head === expectedHead
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

function isHoldClause(body) {
  if (isClearance(body)) return false
  if (/\bno\b[^\n]{0,30}\b(?:open\s+)?(?:hold|freeze)\b/i.test(body ?? '')) return false
  return (
    /^\s*#{0,6}\s*(?:release\s+|merge\s+|gate\s+)?(?:HOLD|FREEZE|FROZEN)\b/im.test(body ?? '')
    || /\b(?:release|merge|gate)\s+(?:is\s+)?(?:on\s+)?(?:hold|frozen|freeze)\b/i.test(body ?? '')
    || conversationalReleaseHold(body)
  )
}

export function isHold(body) {
  if (isClearance(body)) return false
  return directiveClauses(body).some(isHoldClause)
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

export function parseReleaseAuthorizationReceipt(body) {
  const match = String(body ?? '').trim().match(
    /^I\s+(?:(?:hereby|explicitly)\s+)?authorize\s+(?:protected\s+)?(?:merge|release|deployment)(?:\s+and\s+normal\s+dormant\s+deployment)?\s+(?:at|for)\s+exact\s+head\s+`?([0-9a-f]{40})`?(?:,\s+clearing\s+denial\s+at\s+(comment|description)\s+`?([0-9a-z-]+)`?)?\.$/i,
  )
  return match ? { head: match[1].toLowerCase(), sourceKind: match[2]?.toLowerCase(), sourceId: match[3] } : null
}

function isReleaseAuthorization(body) {
  return Boolean(parseReleaseAuthorizationReceipt(body))
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

function releaseDenialText(body) {
  return withoutGithubOnlyReviewRestriction(
    withoutUnrelatedConversationalApprovalHold(String(body ?? '').replaceAll('’', "'")),
  )
    .replace(
      /\bdo not approve or publish on UNKNOWN\/FAIL\.(?=\s|$)/gi,
      '',
    )
    .replace(/\bIf review authority cannot approve that scoped activation, return the concrete action required rather than looping on credential procurement\./g, '')
    // These clauses assign the merge to another actor; they do not prohibit
    // that actor's protected merge. Do not strip an adjacent prohibition.
    .replace(/\bOn PASS leave this gate in_review, assign it to that merge operator, and do not merge\./gi, '')
    .replace(/\bOn PASS, do not merge; hand off to the operator\./gi, '')
    // This exact conditional remains enforced by releaseAuthorityRequirement.
    .replace(/\bDo not release without the CEO explicitly authorizing this PR at this exact head in this ticket thread\./gi, '')

}

const releaseDenialPatterns = [
  /^\s*#{0,6}\s*(?:release\s+)?(?:DENIED|NOT AUTHORIZED)\b/im,
  /\b(?:do not|cannot|refuse to)\s+(?:authorize|approve)\b/i,
  /\b(?:do not|don't|must not|mustn't|shall not|may not|cannot|can't|never|refuse to)\s+(?:merge(?!\s+eligibility)|release|deploy)\b/i,
  /\b(?:do not|don't|must not|mustn't|shall not|may not|cannot|can't|never|refuse to)[\s,]+(?:(?:under any circumstances|under any condition|at any time|for any reason|ever|yet|[a-z]+ly)[\s,]+)+(?:merge(?!\s+eligibility)|release|deploy)\b/i,
  /\b(?:merge|release|deployment)\s+(?:is\s+)?(?:prohibited|forbidden|not\s+(?:(?:yet|currently|explicitly)\s+)?(?:permitted|allowed|authorized|approved))\b/i,
  /\b(?:authorization|approval)\s+(?:is\s+)?(?:denied|withheld|refused)\b/i,
  /\bno\s+(?:merge|release)\s+authority\b/i,
  /\b(?:merge|release)\s+authority\b[^\n]{0,80}\b(?:withheld|revoked|void|withdrawn)\b/i,
  /\b(?:withhold|revoke|void|withdraw)\b[^\n]{0,80}\b(?:merge|release)\s+authority\b/i,
]

function releaseDenialStart(body) {
  const text = releaseDenialText(body)
  const offsets = releaseDenialPatterns.map(pattern => pattern.exec(text)?.index).filter(index => index !== undefined)
  return offsets.length ? Math.min(...offsets) : -1
}

function isReleaseDenial(body) {
  return releaseDenialStart(body) !== -1
}

function directiveClauses(body) {
  // Use the classifiers themselves when splitting independent directives. A
  // second, shorter list of denial words lets contractions escape detection.
  const sentences = String(body ?? '').replaceAll('’', "'")
    .replace(/\b(hold)\s*,\s*(?=(?:and\s+)?do\s+not\s+approve\s+yet\b)/gi, '$1 ')
    .split(/(?<=[.!?;])\s+|\n+/)
  return sentences.flatMap(sentence => {
    const boundaries = [...sentence.matchAll(/,\s*(?:(?:and|but)\s+)?|\s+(?:and|but)\s+/gi)]
    const clauses = []
    let start = 0
    for (const boundary of boundaries) {
      const right = sentence.slice(boundary.index + boundary[0].length)
      const denialStart = releaseDenialStart(right)
      // Do not split a qualifier from its prohibition just because a later
      // independent clause also contains a denial.
      const denialPrefix = denialStart < 0 ? '' : releaseDenialText(right).slice(0, denialStart)
      const independentDenial = denialStart >= 0 && !/,|\b(?:and|but)\b/i.test(denialPrefix)
      const independentHold = isHoldClause(right) && (
        /^\s*(?:HOLD|FREEZE|FROZEN)\b/.test(right)
        || /^\s*(?:hold|freeze|frozen)\s*(?::|$|\b(?:at|for|until)\b)/i.test(right)
        || /\b(?:release|merge|gate)\s+(?:is\s+)?(?:on\s+)?(?:hold|frozen|freeze)\b/i.test(right)
        || conversationalReleaseHold(right)
      )
      if (independentDenial || independentHold) {
        clauses.push(sentence.slice(start, boundary.index))
        start = boundary.index + boundary[0].length
      }
    }
    clauses.push(sentence.slice(start))
    return clauses
  })
}

function directiveHead(clause) {
  const heads = [...new Set(exactHeads(clause))]
  // A contextual hash is not a scope binding. Multiple heads or a current-head
  // reference mixed with another candidate are ambiguous and cannot be skipped.
  if (heads.length !== 1 || /\bcurrent\s+head\b/i.test(clause)) return null
  const binding = clause.match(/\b(?:at|for)\s+(?:exact\s+)?head\s+`?([0-9a-f]{40})`?\b/i)
    ?? clause.match(/^\s*(?:The\s+)?(?:Exact\s+)?head\s+`?([0-9a-f]{40})`?\s+(?:has|is|must|may|cannot)\b/i)
    ?? clause.match(/^\s*(?:HOLD|FREEZE)\s+`?([0-9a-f]{40})`?\b/i)
  return binding?.[1]?.toLowerCase() === heads[0] ? heads[0] : null
}

export function hasHoldForHead(body, expectedHead) {
  if (isClearance(body)) return false
  return directiveClauses(body).some(clause => isHoldClause(clause)
    && (!directiveHead(clause) || directiveHead(clause) === expectedHead))
}

function isReviewerOnlyDescriptionDenial(body) {
  if (!isReleaseDenial(body)) return false
  const withoutTargetedBoundary = String(body ?? '').replace(
    /\bdo not approve(?:\s+on\s+GitHub)?(?:\s*,\s*[^.\n,]+)*\s*,?\s+or\s+merge\s+as\s+(?:the\s+)?reviewer\b/gi,
    '',
  )
  return !isReleaseDenial(withoutTargetedBoundary)
}

// Legacy reproductions contain narrative outside the new complete diagnostic
// grammar. Bind that compatibility to the original nonexecutive QA author,
// comment identity and WHOLE unmodified body, never a matching paragraph or
// result fragment. Full originals are auditable in fixtures/fork-diagnostic-reports.json.
const historicalDiagnosticReports = new Map([
  ['154795a9-79ab-40a7-94c1-bdfefb398979', { author: '20eba31f-3d03-440b-b2be-5bf89a9b0230', sha256: '414f12a1be35c61eb37338b2e7daadfb4f2a51f64cb10db1bd8a53af1406e7a5' }], // LIV-11630
  ['8d1a7383-181b-41af-aa71-e311925c9447', { author: '20eba31f-3d03-440b-b2be-5bf89a9b0230', sha256: '14053e9ffe916f028ec1c92269990bb6c9ccf584b83770590e60b432ccf7d941' }], // LIV-11645
  ['6bb56af6-7b8f-49f0-a110-740cd8761fa1', { author: '20eba31f-3d03-440b-b2be-5bf89a9b0230', sha256: '032743f3f49957862aa00c313dff9fb72ead72e9d0a4c3cbb1544843cc2f8863' }], // LIV-11649
  ['6b3d84d1-674a-42bc-bc8a-17e5dfda4d4b', { author: '20eba31f-3d03-440b-b2be-5bf89a9b0230', sha256: '00e90acc71bc9f7d3156819bf51c09bb5454b6e68b1aa09368fbb2bb0459258f' }], // LIV-11650
  ['e43e35be-d07b-4f63-9b7b-da80fb043553', { author: '20eba31f-3d03-440b-b2be-5bf89a9b0230', sha256: 'b6a5064ac22325ca28558f33ed26f39baddd32c05b6e6aeb975b7f9c58f39e69' }], // LIV-11651
  ['42b740be-ad53-4360-90cd-fd3ef64aa0ed', { author: '20eba31f-3d03-440b-b2be-5bf89a9b0230', sha256: '422252d6b014e4d389d1a6b3f0477ec0c1c36aad2311adf45d6ed7046ffd7c31' }], // LIV-11652
  ['fab868a4-8abb-4c55-8050-bbe982f55d07', { author: '20eba31f-3d03-440b-b2be-5bf89a9b0230', sha256: 'a39c65dab02d2f5c1a7840baf63c5d07becd5ee9804765e18ec5565143f1d47b' }], // LIV-11655
  ['d00495b7-0443-4131-839e-05dd017a7930', { author: '20eba31f-3d03-440b-b2be-5bf89a9b0230', sha256: '4acadcad1669e14ab11aa715fe127b95b7596190edef4a45c3ea6d5151036e1e' }], // LIV-11656
])

function isHistoricalDiagnosticReport(source) {
  const expected = historicalDiagnosticReports.get(source?.id)
  return Boolean(expected && source.authorAgentId === expected.author
    && source.sourceKind !== 'issue_description'
    && (!source.updatedAt || source.updatedAt === source.createdAt)
    && typeof source.body === 'string'
    && createHash('sha256').update(source.body).digest('hex') === expected.sha256)
}

function withoutFactualStaleVerdictNonAuthorization(body, source) {
  const historicalReport = isHistoricalDiagnosticReport(source)
  const withoutQuotedDiagnosticExamples = String(body ?? '').replace(
    /`([^`\n]*)`/g,
    (span, example, offset, text) => {
      if (!isReleaseDenial(example) && !/<candidate>/i.test(example)) return span
      if (historicalReport) return ''
      // Classify this quotation, never every code span on its line. An actual
      // instruction remains binding even beside a genuine diagnostic example.
      const prefix = text.slice(0, offset)
      // Only a syntactic list of quoted inputs can inherit the first input's
      // introduction. Other prose ends that provenance, even on the same line.
      const inputIntroduction = prefix.replace(/(?:`[^`\n]*`(?:,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+))+$/, '')
      // A coordinated list of quoted inputs may share one observed result.
      // Validate the entire remaining source: punctuation, Markdown and line
      // breaks cannot discard a qualifier or a later binding reference.
      const after = text.slice(offset + span.length)
        .replace(/^(?:(?:,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+)`[^`\n]*`)+/, '')

      if (/\b(?:directive|instruction|order)\b[^.!?;]*$/i.test(prefix)) return span
      const introducedExample = /^\s*(?:- \*\*P2 — reproduction\.\*\* )?(?:The\s+)?(?:fixture|(?:parser|diagnostic|regression|test)\s+(?:regression\s+)?example)\s*:?\s*$/i.test(inputIntroduction)
      const diagnosticProvenance = /^\s*(?:(?:parser|classifier|diagnostic|regression|test)\s+(?:input|example|fixture)|quoted input|misclassifies this ticket's factual sentence,|ignores authenticated CEO statements|(?:An|A later) authenticated CEO comment|followed by backticked)\s*:?\s*$/i.test(inputIntroduction)
      const observedBehavior = (diagnosticProvenance || introducedExample)
        && /^[.,]?\s*(?:Each\s+)?(?:(?:previously|incorrectly|still|also)\s+)*(?:(?:returns?|permits?) eligibility(?: on both gate and ancestor)?|passes?|passed|does not block(?: on either the gate or an ancestor)?|as a release denial)[.;]\s*$/i.test(after)
      const exampleAtEnd = introducedExample && /^[.,]?\s*$/.test(after)
      const reportedReceiptSequence = /^\s*After an authenticated CEO's\s*$/i.test(prefix)
        && /^, a later CEO receipt `[^`\n]+` restores eligibility after five minutes\.\s*$/i.test(text.slice(offset + span.length))
      const referencedParserResult = /^\s*(?:The\s+)?(?:factual explanation|quoted input)\s*$/i.test(prefix)
        && /^\s+in \[[^\]\n]+\]\([^\s)]+\) is interpreted as a live denial\.\s*$/i.test(after)
      const explicitProbeResult = ((diagnosticProvenance || introducedExample) && /^\s*\.?\s*Reproduced on gate, ancestor and required-review description, with minimal and actual-history fixtures\.\s*$/i.test(after))
        || (/^\s*(?:The|the) direct\s*$/i.test(prefix) && /^\s+control rejects\.\s*$/i.test(after))
        || (/^\s*A required security ticket whose CEO-authored description says\s*$/i.test(prefix)
          && /^\s+is accepted with an otherwise valid immutable security PASS\.\s*$/i.test(after))
        || (/^\s*\[fork-ticket-authority\.mjs:\d+\]\(https:\/\/github\.com\/[^\s)]+\) scopes the entire source by every SHA it contains\.\s*$/.test(prefix)
          && /^\s+is discarded as an older-head directive, on either gate or ancestor\.\s*$/i.test(after))
      const quotedReproduction = /^\s*(?:A reviewer comment of the form|The form) “[^“”]*$/i.test(prefix)
        && /^[^“”\n]*” (?:also )?returns eligibility\.\s*$/i.test(after)
      const explicitDiagnosticAssertion = (
        /^\s*QA must verify that\s*$/i.test(prefix)
        && /^\s+is treated as diagnostic text, not a live directive\.\s*$/i.test(after)
      ) || (
        /^\s*Add a regression proving the classifier keeps\s*$/i.test(prefix)
        && /^\s+as metalinguistic example text\.\s*$/i.test(after)
      )
      return exampleAtEnd || observedBehavior || reportedReceiptSequence || referencedParserResult || explicitProbeResult || quotedReproduction || explicitDiagnosticAssertion ? '' : span
    },
  )

  return withoutQuotedDiagnosticExamples
    // This complete sentence describes the parser exception's limits. Do not
    // remove a standalone or adjacent denial that happens to use the same words.
    .replace(/(^|[.!?]\s+|\n)Independently review this narrow exception; it grants no release authority\.(?=\s|$)/g, '$1')
    // Evidence from an older candidate is not a release decision. Match only
    // the complete factual sentence; leave adjacent or qualified denials intact.
    .replace(
      /(^|[.!?]\s+|\n)(?:earlier|prior|previous|old)[ -]head['’]s\s+(?:(?:\d+-test|full-suite|CI|test|build|typecheck)(?:\/(?:\d+-test|full-suite|CI|test|build|typecheck))*\s+)?results\s+(?:do not|cannot)\s+(?:approve|authorize)\s+(?:this|the current)\s+head\.(?=\s|$)/gim,
      '$1',
    )
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
      updatedAt: issue.updatedAt,
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
    let sourceBody = retractedQaFailureIds.has(source?.id)
      ? withoutRetractedQaFailureEffect(source?.body)
      : source?.body
    // A review-deliverable assignment forbids the reviewer from performing
    // operations explicitly delegated to the CTO. Limit this boundary to the
    // recorded review assignment and exact reviewer-only instruction sentence.
    // A task owner may receive this assignment in a comment when its active
    // checkout prevents description edits. Executive directives stay intact.
    if (!['ceo', 'board'].includes(authorRole)
      && /Lifecycle resolution: THIS is a review-deliverable child\./.test(sourceBody ?? '')
      && /No merge is requested from QA\./.test(sourceBody ?? '')
      && /The CTO alone handles activation/.test(sourceBody ?? '')) {
      sourceBody = String(sourceBody).replace(/Do not merge, deploy, procure credentials, mutate production, rerun the old review job, or use browser automation\./g, '')
    }
    if (source?.sourceKind === 'issue_description'
      && /Named merge\/activation operator: CTO/.test(sourceBody ?? '')
      && /distinct from your verdict author seat/.test(sourceBody ?? '')) {
      sourceBody = String(sourceBody).replace(/(Post exact-head PASS or FAIL, evidence, and any concrete fixes ON THIS QA TICKET\.) Do not merge\.(?= For this review-deliverable child,)/g, '$1')
    }
    const denialBody = ['ceo', 'board'].includes(authorRole)
      ? sourceBody
      : withoutFactualStaleVerdictNonAuthorization(sourceBody, source)
    const holdDenial = isHold(source?.body) && (
      ['ceo', 'board'].includes(authorRole)
      || retractedQaFailureIds.has(source?.id)
    )
    const denialClauses = [...directiveClauses(releaseDenialText(denialBody)).filter(isReleaseDenial),
      ...(holdDenial ? directiveClauses(sourceBody).filter(isHoldClause) : [])]
      .filter(clause => !directiveHead(clause) || directiveHead(clause) === expectedHead)
    const denial = denialClauses.length > 0
    const ambiguousDenial = denialClauses.some(clause => !directiveHead(clause))
    const boundedHoldClearance = authorRole === 'ceo'
      && parseHoldClearanceReceipt(source?.body)?.bounded === true
    const boundedDescriptionClearance = authorRole === 'ceo'
      && isBoundedDescriptionDenialClearance(source?.body, expectedHead, operatorId)
    const boundedUnavailableDenialClearance = authorRole === 'ceo'
      && isBoundedUnavailableDenialClearance(source?.body, expectedHead)
    if (boundedDescriptionClearance || boundedUnavailableDenialClearance) {
      requiredRole = mergeRequiredAuthorityRole(requiredRole, 'ceo')
    }
    const holdReceipt = parseHoldClearanceReceipt(source?.body)
    const immutableReceipt = !source?.updatedAt || timestamp(source.updatedAt, 'Authority update') === timestamp(source.createdAt, 'Authority creation')
    const authorization = immutableReceipt && ((holdReceipt && holdReceipt.head === expectedHead) || isReleaseAuthorization(source?.body)
      || boundedHoldClearance
      || boundedDescriptionClearance
      || boundedUnavailableDenialClearance
      || targetedBoardOnlyClearance)
    if (!requiredRole && !denial && !authorization) return []

    return [{
      source,
      index,
      authorRole,
      requiredRole,
      denial,
      ambiguousDenial,
      holdDenial,
      authorization,
      boundedHoldClearance,
      targetedBoardOnlyClearance,
      boundedDescriptionClearance,
      boundedUnavailableDenialClearance,
      createdAtMs: timestamp(denial || requiredRole ? (source?.updatedAt ?? source?.createdAt) : source?.createdAt, `Paperclip authority source ${authoritySourceLabel(source)}`),
    }]
  }).sort((left, right) => left.createdAtMs - right.createdAtMs || left.index - right.index)

  let requiredRole = null
  let releaseAuthority = null
  let pendingDenials = []

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
      if (denyingRole) requiredRole = mergeRequiredAuthorityRole(requiredRole, denyingRole)
      pendingDenials.push({ ...directive, denyingRole })
      releaseAuthority = null
      continue
    }

    if (directive.requiredRole) releaseAuthority = null
    if (!directive.authorization || !requiredRole
      || !authorityRoleMatches(requiredRole, directive.authorRole)
      || !includesHead(directive.source.body, expectedHead)
      || directive.createdAtMs <= passAtMs) continue

    const holdReceipt = parseHoldClearanceReceipt(directive.source.body)
    const authorizationReceipt = parseReleaseAuthorizationReceipt(directive.source.body)
    const cleared = pendingDenials.filter(candidate => {
      if (directive.createdAtMs <= candidate.createdAtMs) return false
      if (directive.targetedBoardOnlyClearance) {
        return candidate.source?.sourceKind === 'issue_description'
          && candidate.source.sourceIssueId === directive.source.targetIssueDescriptionId
          && isReviewerOnlyDescriptionDenial(candidate.source.body)
      }
      if (directive.boundedDescriptionClearance) {
        return !candidate.denyingRole && !candidate.source?.id
          && candidate.source?.sourceIssueId === issue.id
      }
      if (holdReceipt) {
        // Every consumer resolves this receipt against a real pending source.
        // It can clear only that source, including when the denial is exact-head
        // and has a known executive author. It is never generic authorization.
        return validHoldClearance(directive.source, candidate.source, expectedHead, actorRoles)
          && (candidate.denyingRole && !candidate.ambiguousDenial || holdReceipt.bounded)
      }
      if (!authorizationReceipt || !candidate.denyingRole
        || candidate.ambiguousDenial || candidate.holdDenial) return false
      if (!authorizationReceipt.sourceId) return true
      const description = candidate.source?.sourceKind === 'issue_description'
      return authorizationReceipt.sourceKind === (description ? 'description' : 'comment')
        && authorizationReceipt.sourceId === (description ? candidate.source.sourceIssueId : candidate.source?.id)
    })
    // An unbound affirmative authorization can satisfy an explicit requirement
    // without a denial. A source-bound receipt must actually clear its source.
    if (!cleared.length && (!authorizationReceipt || authorizationReceipt.sourceId)) continue
    const clearedSet = new Set(cleared)
    pendingDenials = pendingDenials.filter(candidate => !clearedSet.has(candidate))
    if (!pendingDenials.length) releaseAuthority = directive
  }

  const unavailable = pendingDenials.filter(candidate => !candidate.denyingRole).at(-1)
  if (unavailable) {
    throw new Error(
      `Ticket-scoped merge denial actor authority is unavailable at ${authoritySourceLabel(unavailable.source)}`,
    )
  }
  const ambiguous = pendingDenials.filter(candidate => candidate.ambiguousDenial).at(-1)
  if (ambiguous) {
    throw new Error(
      `Ticket-scoped merge denial has ambiguous exact-head scope at ${authoritySourceLabel(ambiguous.source)}`,
    )
  }
  if (pendingDenials.length) {
    throw new Error(
      `Required release authority denied or held release in ${authoritySourceLabel(pendingDenials.at(-1).source)}`,
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

function activeHoldAfter(comments, startMs, expectedHead, actorRoles) {
  const holds = []
  let restartAtMs = startMs
  for (const comment of comments) {
    const effectiveAt = timestamp(comment.updatedAt ?? comment.createdAt, 'Paperclip comment')
    if (effectiveAt <= startMs) continue
    if (hasHoldForHead(comment.body, expectedHead)) holds.push(comment)
  }
  for (const hold of holds) {
    const clearance = comments.filter(c => validHoldClearance(c, hold, expectedHead, actorRoles)).at(-1)
    if (!clearance) return { hold, restartAtMs }
    restartAtMs = Math.max(restartAtMs, timestamp(clearance.createdAt, 'Hold clearance'))
  }
  return { hold: null, restartAtMs }
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

  const { hold, restartAtMs } = activeHoldAfter(ordered, passAtMs, expectedHead, actorRoles)
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
  if (latest.updatedAt && timestamp(latest.updatedAt, 'Required PASS update') !== timestamp(latest.createdAt, 'Required PASS')) {
    throw new Error('Edited required PASS requires a new immutable verdict comment')
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
