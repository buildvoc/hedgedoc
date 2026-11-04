import { NextRequest, NextResponse } from 'next/server'
import { addOkfRelation, readOkfRelations } from './_store'
import { authorizedOkfOperator, okfRelationsWriteEnabled } from './_auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAINTAIN = process.env.MEMEX_WIKI_MAINTAIN_URL ??
  'http://127.0.0.1:3101/memex-wiki-maintain'

type CataloguePage = { alias: string; title: string; pageType: string }

async function catalogue(): Promise<{
  topics: CataloguePage[]
  entities: CataloguePage[]
  counts: {
    sourceSummary: number
    entity: number
    topic: number
    comparison: number
    synthesis: number
    total: number
  }
}> {
  const response = await fetch(MAINTAIN, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Wiki catalogue HTTP ${response.status}`)
  const json: unknown = await response.json()
  if (!json || typeof json !== 'object') throw new Error('Invalid wiki catalogue')
  const pages = (json as { pages?: unknown }).pages
  if (!Array.isArray(pages)) throw new Error('Missing wiki catalogue pages')
  const known: CataloguePage[] = pages.flatMap((page): CataloguePage[] => {
    if (!page || typeof page !== 'object') return []
    const item = page as Record<string, unknown>
    return typeof item.alias === 'string' && typeof item.title === 'string' &&
      (item.pageType === 'topic' || item.pageType === 'entity')
      ? [{ alias: item.alias, title: item.title, pageType: item.pageType }]
      : []
  })
  const pageTypes = pages.flatMap((page): string[] => {
    if (!page || typeof page !== 'object') return []
    const pageType = (page as Record<string, unknown>).pageType
    return typeof pageType === 'string' ? [pageType] : []
  })

  const counts = {
    sourceSummary: pageTypes.filter((t) => t === 'source-summary').length,
    entity: pageTypes.filter((t) => t === 'entity').length,
    topic: pageTypes.filter((t) => t === 'topic').length,
    comparison: pageTypes.filter((t) => t === 'comparison').length,
    synthesis: pageTypes.filter((t) => t === 'synthesis').length,
    total: 0,
  }
  counts.total = counts.sourceSummary + counts.entity + counts.topic +
    counts.comparison + counts.synthesis

  return {
    topics: known.filter((p) => p.pageType === 'topic'),
    entities: known.filter((p) => p.pageType === 'entity'),
    counts,
  }
}

export async function GET() {
  try {
    const [snapshot, pages] = await Promise.all([readOkfRelations(), catalogue()])
    return NextResponse.json({
      ...pages,
      relations: snapshot.document.relations,
      revision: snapshot.revision,
      writeEnabled: await okfRelationsWriteEnabled(),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) },
      { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  // Restrict both manual and bulk writes to the named, signed-in operator.
  if (!(await authorizedOkfOperator(request))) {
    return NextResponse.json({ error: 'Sign in as the configured HedgeDoc OKF operator' }, { status: 403 })
  }
  // This is an operator-only feature. Do not enable on untrusted/public instances.
  if (!(await okfRelationsWriteEnabled())) {
    return NextResponse.json({ error: 'OKF relationship writes disabled by operator' }, { status: 403 })
  }
  const origin = request.headers.get('origin')
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  try {
    if (!origin || !host || new URL(origin).host !== host) {
      return NextResponse.json({ error: 'Origin mismatch' }, { status: 403 })
    }
  } catch {
    return NextResponse.json({ error: 'Invalid Origin' }, { status: 403 })
  }
  try {
    const body: unknown = await request.json()
    if (!body || typeof body !== 'object') throw new Error('JSON object required')
    const value = body as Record<string, unknown>
    if (value.action !== 'add' || value.confirmation !== 'APPLY') {
      return NextResponse.json({ error: 'Explicit APPLY confirmation required' }, { status: 400 })
    }
    const topicAlias = value.topicAlias
    const entityAlias = value.entityAlias
    const expectedRevision = value.expectedRevision
    const rationale = typeof value.rationale === 'string' ? value.rationale.trim() : ''
    if (typeof topicAlias !== 'string' || typeof entityAlias !== 'string' ||
      typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision) ||
      rationale.length < 12 || rationale.length > 500) {
      return NextResponse.json({ error: 'Invalid aliases, revision, or rationale (12–500 chars)' }, { status: 400 })
    }
    const pages = await catalogue()
    if (!pages.topics.some((p) => p.alias === topicAlias) ||
      !pages.entities.some((p) => p.alias === entityAlias)) {
      return NextResponse.json({ error: 'Aliases must be registered Topic and Entity pages' }, { status: 400 })
    }
    const relations = await addOkfRelation({ topicAlias, entityAlias, rationale }, expectedRevision)
    return NextResponse.json({ committed: true, count: relations.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = message === 'STALE_RELATIONS' || message === 'DUPLICATE_RELATION' ||
      (error as NodeJS.ErrnoException).code === 'EEXIST' ? 409 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
