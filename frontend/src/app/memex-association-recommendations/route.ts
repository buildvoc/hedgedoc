import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RECOMMENDATIONS_PATH =
  process.env.MEMEX_ASSOCIATION_RECOMMENDATIONS_FILE ??
  '/data/projects/hedgedoc/memex/association-recommendations.jsonl'

const ASSOCIATIONS_PATH =
  process.env.MEMEX_ASSOCIATIONS_FILE ??
  '/data/projects/hedgedoc-nb-frontend/data/memex-associations.json'

interface AssociationRecommendation {
  id: string
  source: string
  sourceTitle?: string
  target: string
  targetTitle?: string
  relation: 'associated_with'
  createdBy: 'llm'
  reason: string
  confidence: number
  mainModel?: string
  recommendationSource?: string
  sourceRevision?: string
  snapshotRevision?: string
  queueItemId?: string
  recommendedAt: string
  status: 'pending' | 'accepted' | 'rejected' | 'superseded'
  reviewedAt?: string
  canonicalAction?: string
}

interface CanonicalAssociation {
  source: string
  target: string
  relation: string
  createdBy: string
  reason?: string
}

interface CanonicalStore {
  version?: number
  associations: CanonicalAssociation[]
}

const readRecommendations = async (): Promise<AssociationRecommendation[]> => {
  try {
    const text = await readFile(RECOMMENDATIONS_PATH, 'utf8')
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AssociationRecommendation)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

const writeRecommendations = async (
  rows: AssociationRecommendation[],
): Promise<void> => {
  await mkdir(dirname(RECOMMENDATIONS_PATH), { recursive: true })
  const tempPath = `${RECOMMENDATIONS_PATH}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(
    tempPath,
    rows.map((row) => JSON.stringify(row)).join('\n') +
      (rows.length ? '\n' : ''),
    'utf8',
  )
  await rename(tempPath, RECOMMENDATIONS_PATH)
}

const readCanonicalStore = async (): Promise<CanonicalStore> => {
  const payload = JSON.parse(await readFile(ASSOCIATIONS_PATH, 'utf8')) as CanonicalStore
  if (!payload || !Array.isArray(payload.associations)) {
    throw new Error('Invalid canonical Memex association store')
  }
  return payload
}

const writeCanonicalStore = async (store: CanonicalStore): Promise<void> => {
  const tempPath = `${ASSOCIATIONS_PATH}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(
    tempPath,
    `${JSON.stringify(
      {
        ...store,
        version: store.version ?? 2,
        associations: store.associations,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await rename(tempPath, ASSOCIATIONS_PATH)
}

const pairKey = (source: string, target: string): string =>
  [source.trim(), target.trim()].sort().join('\u0000')

const acceptRecommendation = async (
  recommendation: AssociationRecommendation,
): Promise<string> => {
  const store = await readCanonicalStore()
  const key = pairKey(recommendation.source, recommendation.target)
  const pairIndexes = store.associations
    .map((association, index) => ({ association, index }))
    .filter(
      ({ association }) =>
        pairKey(association.source ?? '', association.target ?? '') === key,
    )

  const userEdge = pairIndexes.find(
    ({ association }) => association.createdBy === 'user',
  )
  if (userEdge) return 'user-edge-preserved'

  const source = [recommendation.source, recommendation.target].sort()[0]
  const target = [recommendation.source, recommendation.target].sort()[1]
  const canonical: CanonicalAssociation = {
    source,
    target,
    relation: 'associated_with',
    createdBy: 'llm',
    reason: recommendation.reason,
  }

  const llmEdge = pairIndexes.find(
    ({ association }) => association.createdBy === 'llm',
  )

  if (llmEdge) {
    store.associations[llmEdge.index] = canonical
    await writeCanonicalStore(store)
    return 'updated-existing-llm-edge'
  }

  store.associations.push(canonical)
  store.associations.sort((a, b) => {
    const sourceCompare = String(a.source).localeCompare(String(b.source))
    if (sourceCompare !== 0) return sourceCompare
    const targetCompare = String(a.target).localeCompare(String(b.target))
    if (targetCompare !== 0) return targetCompare
    return String(a.createdBy).localeCompare(String(b.createdBy))
  })
  await writeCanonicalStore(store)
  return 'added-canonical-edge'
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const requestedStatus = url.searchParams.get('status')?.trim()
    const rows = await readRecommendations()
    const filtered = requestedStatus
      ? rows.filter((row) => row.status === requestedStatus)
      : rows

    filtered.sort((a, b) =>
      String(b.recommendedAt ?? '').localeCompare(String(a.recommendedAt ?? '')),
    )

    return NextResponse.json(
      {
        items: filtered,
        pendingCount: rows.filter((row) => row.status === 'pending').length,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to read association recommendations',
      },
      { status: 500 },
    )
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      id?: unknown
      action?: unknown
    }
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const action = typeof body.action === 'string' ? body.action.trim() : ''

    if (!id || !['accept', 'reject'].includes(action)) {
      return NextResponse.json(
        { error: 'Expected recommendation id and action accept|reject' },
        { status: 400 },
      )
    }

    const rows = await readRecommendations()
    const recommendation = rows.find((row) => row.id === id)
    if (!recommendation) {
      return NextResponse.json({ error: 'Recommendation not found' }, { status: 404 })
    }
    if (recommendation.status !== 'pending') {
      return NextResponse.json(
        { error: `Recommendation is already ${recommendation.status}` },
        { status: 409 },
      )
    }

    const reviewedAt = new Date().toISOString()
    let canonicalAction = 'none'

    if (action === 'accept') {
      canonicalAction = await acceptRecommendation(recommendation)
      recommendation.status = 'accepted'
    } else {
      recommendation.status = 'rejected'
      canonicalAction = 'rejected-no-canonical-change'
    }

    recommendation.reviewedAt = reviewedAt
    recommendation.canonicalAction = canonicalAction
    await writeRecommendations(rows)

    return NextResponse.json({
      item: recommendation,
      canonicalAction,
      pendingCount: rows.filter((row) => row.status === 'pending').length,
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to review association recommendation',
      },
      { status: 500 },
    )
  }
}
