import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

type TrailMember = {
  alias: string
  title?: string
}

type TrailInput = {
  id: string
  name: string
  reason?: string
  origin?: string
  status?: string
  members: TrailMember[]
}

type PairEvidence = {
  trailIds: [string, string]
  sharedMemberAliases: string[]
  sharedMembers: number
  unionMembers: number
  jaccard: number
}

type PairwiseReview = {
  trailIds: [string, string]
  trailNames: [string, string]
  classification: string
  confidence: number
  overlap: string
  distinction: string
  recommendation: string
}

const CLASSIFICATIONS = new Set([
  'distinct',
  'partial_overlap',
  'strong_overlap',
  'duplicate',
])

const MAX_PAIR_REPAIR_CALLS = 3

function cleanText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function parseConfidence(value: unknown): number | null {
  let number: number

  if (typeof value === 'number') {
    number = value
  } else if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return null

    const match = text.match(/-?\d+(?:\.\d+)?/)
    if (!match) return null

    number = Number(match[0])
    if (!Number.isFinite(number)) return null

    const explicitlyPercent = /%|\bpercent\b/i.test(text)
    if (explicitlyPercent || number > 1) number /= 100
  } else {
    if (value === null || value === undefined) return null
    number = Number(value)
    if (!Number.isFinite(number)) return null
    if (number > 1) number /= 100
  }

  return Math.max(0, Math.min(1, number))
}

function normalizeMember(value: unknown): TrailMember | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const alias = cleanText(row.alias)
  if (!alias) return null
  return {
    alias,
    title: cleanText(row.title) || undefined,
  }
}

function normalizeTrail(value: unknown): TrailInput | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>

  const id = cleanText(row.id)
  const name = cleanText(row.name)
  if (!id || !name) return null

  const members = Array.isArray(row.members)
    ? row.members.map(normalizeMember).filter((item): item is TrailMember => item !== null)
    : []

  return {
    id,
    name,
    reason: cleanText(row.reason) || undefined,
    origin: cleanText(row.origin) || undefined,
    status: cleanText(row.status) || undefined,
    members,
  }
}

function pairEvidence(a: TrailInput, b: TrailInput): PairEvidence {
  const aMembers = new Set(a.members.map((member) => member.alias))
  const bMembers = new Set(b.members.map((member) => member.alias))

  const sharedMemberAliases = [...aMembers]
    .filter((alias) => bMembers.has(alias))
    .sort((left, right) => left.localeCompare(right))

  const union = new Set([...aMembers, ...bMembers])
  const jaccard = union.size === 0 ? 0 : sharedMemberAliases.length / union.size

  return {
    trailIds: [a.id, b.id],
    sharedMemberAliases,
    sharedMembers: sharedMemberAliases.length,
    unionMembers: union.size,
    jaccard: Number(jaccard.toFixed(4)),
  }
}

function buildEvidence(trails: TrailInput[]): PairEvidence[] {
  const result: PairEvidence[] = []
  for (let left = 0; left < trails.length; left += 1) {
    for (let right = left + 1; right < trails.length; right += 1) {
      result.push(pairEvidence(trails[left], trails[right]))
    }
  }
  return result
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error('LLM returned an empty response')
  }

  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Fall through to extracting the first JSON object.
  }

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('LLM response did not contain a JSON object')
  }

  const parsed = JSON.parse(text.slice(start, end + 1))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM response JSON was not an object')
  }
  return parsed as Record<string, unknown>
}

function normalizeClassification(value: unknown): string {
  const classification = cleanText(value).toLowerCase()
  return CLASSIFICATIONS.has(classification) ? classification : 'distinct'
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => cleanText(item)).filter(Boolean)
    : []
}

function normalizeTrailReference(value: unknown): string {
  return cleanText(value).replace(/\s+/g, ' ').toLowerCase()
}

function resolveTrailReference(value: unknown, trails: TrailInput[]): TrailInput | null {
  const reference = cleanText(value)
  if (!reference) return null

  const exactId = trails.find((trail) => trail.id === reference)
  if (exactId) return exactId

  const normalized = normalizeTrailReference(reference)
  return (
    trails.find((trail) => normalizeTrailReference(trail.name) === normalized) ??
    trails.find((trail) => normalizeTrailReference(trail.id) === normalized) ??
    null
  )
}

function pairKey(ids: [string, string]): string {
  return [...ids].sort().join('::')
}

function normalizePairwise(
  value: unknown,
  trails: TrailInput[],
  singlePairFallbackConfidence: number | null,
): PairwiseReview[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const row = item as Record<string, unknown>
      const references = Array.isArray(row.trailIds) ? row.trailIds.slice(0, 2) : []
      if (references.length !== 2) return null

      const left = resolveTrailReference(references[0], trails)
      const right = resolveTrailReference(references[1], trails)
      if (!left || !right || left.id === right.id) return null

      const key = pairKey([left.id, right.id])
      if (seen.has(key)) return null
      seen.add(key)

      return {
        trailIds: [left.id, right.id] as [string, string],
        trailNames: [left.name, right.name] as [string, string],
        classification: normalizeClassification(row.classification),
        confidence:
          parseConfidence(row.confidence) ??
          (trails.length === 2 ? singlePairFallbackConfidence : null) ??
          0,
        overlap: cleanText(row.overlap),
        distinction: cleanText(row.distinction),
        recommendation: cleanText(row.recommendation),
      }
    })
    .filter((item): item is PairwiseReview => item !== null)
}

async function callOllama(
  ollamaBase: string,
  model: string,
  prompt: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${ollamaBase.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      format: 'json',
      options: {
        temperature: 0.1,
        num_ctx: 32768,
      },
    }),
  })

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000)
    throw new Error(`Ollama returned ${response.status}: ${detail}`)
  }

  const ollamaPayload = (await response.json()) as Record<string, unknown>
  const message =
    ollamaPayload.message && typeof ollamaPayload.message === 'object'
      ? (ollamaPayload.message as Record<string, unknown>)
      : {}

  return parseJsonObject(cleanText(message.content))
}

function requiredPairsText(evidence: PairEvidence[], trails: TrailInput[]): string {
  const trailById = new Map(trails.map((trail) => [trail.id, trail]))

  return evidence
    .map((pair, index) => {
      const left = trailById.get(pair.trailIds[0])
      const right = trailById.get(pair.trailIds[1])
      return `${index + 1}. ${pair.trailIds[0]} (${left?.name ?? 'Selected trail'}) <-> ${
        pair.trailIds[1]
      } (${right?.name ?? 'Selected trail'})`
    })
    .join('\n')
}

function repairPrompt(
  missingEvidence: PairEvidence[],
  trails: TrailInput[],
): string {
  const neededIds = new Set(missingEvidence.flatMap((pair) => pair.trailIds))
  const neededTrails = trails.filter((trail) => neededIds.has(trail.id))

  return `You are completing a Memex trail overlap review that was missing pairwise results.

This is READ-ONLY. Do not merge, rename, edit, or delete trails.

Return one pairwise review for EVERY REQUIRED PAIR below. Do not omit any pair and do not add extra pairs.
There are exactly ${missingEvidence.length} required pair(s), so pairwise MUST contain exactly ${missingEvidence.length} item(s).

Use these classifications only: distinct, partial_overlap, strong_overlap, duplicate.
Every confidence MUST be a JSON number from 0.0 to 1.0.
In trailIds, use the exact ids shown in REQUIRED PAIRS.

Return JSON only:
{
  "pairwise": [
    {
      "trailIds": ["exact-id-a", "exact-id-b"],
      "classification": "distinct|partial_overlap|strong_overlap|duplicate",
      "confidence": 0.0,
      "overlap": "what actually overlaps",
      "distinction": "what remains different",
      "recommendation": "what a human curator should consider"
    }
  ]
}

REQUIRED PAIRS (${missingEvidence.length}):
${requiredPairsText(missingEvidence, trails)}

TRAILS NEEDED FOR THESE PAIRS:
${JSON.stringify(neededTrails, null, 2)}

DETERMINISTIC MEMBER-OVERLAP EVIDENCE:
${JSON.stringify(missingEvidence, null, 2)}
`
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>
    const rawTrails = Array.isArray(body.trails) ? body.trails : []
    const trails = rawTrails
      .map(normalizeTrail)
      .filter((trail): trail is TrailInput => trail !== null)

    const uniqueTrails = [...new Map(trails.map((trail) => [trail.id, trail])).values()]

    if (uniqueTrails.length < 2) {
      return NextResponse.json(
        { error: 'Select at least two valid trails for overlap review.' },
        { status: 400 },
      )
    }

    const evidence = buildEvidence(uniqueTrails)
    const expectedPairCount = evidence.length

    const prompt = `You are reviewing selected Memex trails for semantic overlap.

This is a READ-ONLY review. Do not merge, rename, edit, or delete anything.

Classify overlap by the conceptual traversal a user would expect:
- intent / question the trail helps answer
- scope and subject boundary
- action or traversal purpose
- context
- expected outcome

Important:
- Similar wording is NOT enough to call two trails duplicates.
- Sharing the same place, broad topic, category, chronology, title words, or keywords is NOT enough.
- Shared source members are useful structural evidence but are NOT by themselves proof of semantic duplication.
- "duplicate" means one trail can replace the other with minimal conceptual loss.
- "strong_overlap" means substantial redundancy remains, but there is still a meaningful distinction.
- "partial_overlap" means they intersect but have clearly complementary purposes or scopes.
- "distinct" means the conceptual traversal/purpose is materially different.
- Do not auto-merge. Recommendations may say keep separate, rename for clarity, narrow one trail, or consider a manual merge.
- Prefer preserving useful distinctions.
- In every pairwise item, trailIds MUST contain the exact selected trail id values from REQUIRED PAIRS. Never put a trail name in trailIds.
- Every confidence value MUST be a JSON number from 0.0 to 1.0 (for example 0.90), never 90 and never "90%".
- You MUST review EVERY unique selected-trail pair exactly once.
- ${uniqueTrails.length} selected trails produce exactly ${expectedPairCount} unique pairs.
- Therefore pairwise MUST contain exactly ${expectedPairCount} items. Do not omit pairs and do not add extra pairs.

Return JSON only, exactly in this shape:
{
  "classification": "distinct|partial_overlap|strong_overlap|duplicate",
  "confidence": 0.0,
  "summary": "overall review",
  "recommendation": "read-only recommendation",
  "distinctions": ["important distinction"],
  "pairwise": [
    {
      "trailIds": ["exact-id-a", "exact-id-b"],
      "classification": "distinct|partial_overlap|strong_overlap|duplicate",
      "confidence": 0.0,
      "overlap": "what actually overlaps",
      "distinction": "what remains different",
      "recommendation": "what a human curator should consider"
    }
  ]
}

REQUIRED PAIRS (${expectedPairCount}):
${requiredPairsText(evidence, uniqueTrails)}

SELECTED TRAILS:
${JSON.stringify(uniqueTrails, null, 2)}

DETERMINISTIC MEMBER-OVERLAP EVIDENCE:
${JSON.stringify(evidence, null, 2)}
`

    const ollamaBase =
      process.env.MEMEX_OLLAMA_URL ??
      process.env.OLLAMA_URL ??
      'http://192.168.1.99:11434'

    const model =
      process.env.MEMEX_OLLAMA_MODEL ??
      process.env.OLLAMA_MODEL ??
      'gemma4:26b'

    const review = await callOllama(ollamaBase, model, prompt)
    const overallConfidence = parseConfidence(review.confidence)

    const pairwiseByKey = new Map<string, PairwiseReview>()
    for (const pair of normalizePairwise(
      review.pairwise,
      uniqueTrails,
      uniqueTrails.length === 2 ? overallConfidence : null,
    )) {
      pairwiseByKey.set(pairKey(pair.trailIds), pair)
    }

    let repairCalls = 0

    while (pairwiseByKey.size < expectedPairCount && repairCalls < MAX_PAIR_REPAIR_CALLS) {
      const missingEvidence = evidence.filter(
        (pair) => !pairwiseByKey.has(pairKey(pair.trailIds)),
      )
      if (missingEvidence.length === 0) break

      repairCalls += 1
      const repair = await callOllama(
        ollamaBase,
        model,
        repairPrompt(missingEvidence, uniqueTrails),
      )

      for (const pair of normalizePairwise(repair.pairwise, uniqueTrails, null)) {
        const key = pairKey(pair.trailIds)
        if (missingEvidence.some((item) => pairKey(item.trailIds) === key)) {
          pairwiseByKey.set(key, pair)
        }
      }
    }

    const missingPairs = evidence.filter(
      (pair) => !pairwiseByKey.has(pairKey(pair.trailIds)),
    )

    if (missingPairs.length > 0) {
      throw new Error(
        `LLM returned an incomplete pairwise review: ${pairwiseByKey.size}/${expectedPairCount} pairs after ${repairCalls} repair call(s). No partial review was returned.`,
      )
    }

    const completePairwise = evidence.map((pair) => pairwiseByKey.get(pairKey(pair.trailIds))!)

    return NextResponse.json({
      ok: true,
      readOnly: true,
      model,
      selectedTrailCount: uniqueTrails.length,
      expectedPairCount,
      reviewedPairCount: completePairwise.length,
      repairCalls,
      deterministicEvidence: evidence,
      review: {
        classification: normalizeClassification(review.classification),
        confidence: overallConfidence ?? 0,
        summary: cleanText(review.summary),
        recommendation: cleanText(review.recommendation),
        distinctions: stringList(review.distinctions),
        pairwise: completePairwise,
      },
    })
  } catch (error) {
    console.error('Memex trail overlap review failed', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unknown Memex trail overlap review error',
      },
      { status: 500 },
    )
  }
}
