import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { NextRequest, NextResponse } from 'next/server'

import { authorizedOkfOperator, okfRelationsWriteEnabled } from '../_auth'
import { aggregate, readSourceIndex, type ConceptGroup, type Cooccurrence, type SourceIndex } from '../_source_index'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Independent publication checkpoint. It does not modify the source-review
// checkpoint, canonical raw notes, trails, or approved associations.
const PROGRESS_PATH = process.env.MEMEX_OKF_WIKI_PUBLISH_PATH ??
  '/data/projects/hedgedoc/memex/okf-wiki-publish.json'
const MAINTAIN_URL = (process.env.MEMEX_WIKI_MAINTAIN_URL ??
  'http://127.0.0.1:3101/memex-wiki-maintain').replace(/\/+$/, '')
const GRAPH_ALIAS = 'memex-wiki-synthesis-okf-source-navigation-graph'
const GRAPH_TITLE = 'OKF Source Navigation Graph'
const MAX_STEP = 8
const GAP_MS = 90_000 // Paces bulk writes beneath unauthenticated API limits with headroom for other traffic.

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const key = (x: string): string => x.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
const slug = (x: string): string => x.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96) || 'page'
const aliasFor = (kind: 'topic' | 'entity', name: string): string =>
  `memex-wiki-${kind}-${slug(name)}`.slice(0, 160)
const safeMarkdown = (x: string): string => x.replace(/[\r\n<>\[\];]/g, ' ').replace(/\s+/g, ' ').trim()
const validAlias = (x: unknown): x is string =>
  typeof x === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(x)

class RateLimited extends Error {
  constructor(readonly retrySeconds: number) {
    super(`HedgeDoc API 429; progress saved. Retry in ${retrySeconds}s.`)
  }
}

type Kind = 'topic' | 'entity'
type Item = { kind: Kind; name: string; alias: string }
type Job = {
  version: 1
  id: string
  state: 'running' | 'paused' | 'completed'
  indexRevision: string
  indexSourceCount: number
  createdAt: string
  updatedAt: string
  items: Item[]
  cursor: number
  created: number
  skippedExisting: number
  rejected: string[]
  lastWriteAt: number
  graphState?: 'pending' | 'created' | 'preserved'
}
type CataloguePage = { alias: string; pageType: string; title: string }
let busy = false
const exclusive = async <T,>(fn: () => Promise<T>): Promise<T> => {
  if (busy) throw new Error('OKF_WIKI_PUBLISH_BUSY')
  busy = true
  try { return await fn() } finally { busy = false }
}
const sameOrigin = (request: NextRequest): boolean => {
  const origin = request.headers.get('origin')
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  try { return !!origin && !!host && new URL(origin).host === host } catch { return false }
}

const readJob = async (): Promise<Job | null> => {
  let raw = ''
  try { raw = await readFile(PROGRESS_PATH, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const job: unknown = JSON.parse(raw)
  if (!isObject(job) || job.version !== 1 || !Array.isArray(job.items) ||
      !job.items.every((item: unknown) => isObject(item) &&
        (item.kind === 'topic' || item.kind === 'entity') &&
        typeof item.name === 'string' && validAlias(item.alias)) ||
      typeof job.id !== 'string' || typeof job.indexRevision !== 'string' ||
      typeof job.cursor !== 'number' || typeof job.created !== 'number') {
    throw new Error('Invalid OKF Wiki publication checkpoint; refusing to overwrite')
  }
  return job as unknown as Job
}
const writeJob = async (job: Job): Promise<void> => {
  await mkdir(dirname(PROGRESS_PATH), { recursive: true })
  const temp = `${PROGRESS_PATH}.tmp-${randomBytes(8).toString('hex')}`
  await writeFile(temp, JSON.stringify(job, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  await rename(temp, PROGRESS_PATH)
}
const publicJob = (job: Job | null) => job ? {
  available: true, id: job.id, state: job.state, total: job.items.length,
  processed: job.cursor, created: job.created,
  skippedExisting: job.skippedExisting, rejected: job.rejected.slice(0, 30),
  rejectedCount: job.rejected.length, indexSourceCount: job.indexSourceCount,
  minimumWaitSeconds: Math.max(0, Math.ceil((job.lastWriteAt + GAP_MS - Date.now()) / 1000)),
  updatedAt: job.updatedAt, graphState: job.graphState ?? 'pending',
  graphAlias: job.graphState && job.graphState !== 'pending' ? GRAPH_ALIAS : null,
} : { available: false }

const requestJson = async (url: string, init: RequestInit = {}): Promise<Record<string, unknown>> => {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(90_000), ...init })
  const text = await response.text()
  if (response.status === 429 || (response.status === 500 && /failed \(429\)/i.test(text))) {
    const raw = response.headers.get('retry-after')
    const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : 300
    throw new RateLimited(Math.max(10, Math.min(600, seconds)))
  }
  if (!response.ok) throw new Error(`Wiki maintenance HTTP ${response.status}: ${text.slice(0, 350)}`)
  const value: unknown = JSON.parse(text)
  if (!isObject(value)) throw new Error('Wiki maintenance returned invalid JSON')
  return value
}
const readCatalogue = async (): Promise<CataloguePage[]> => {
  const data = await requestJson(MAINTAIN_URL)
  if (!Array.isArray(data.pages)) throw new Error('Invalid Wiki catalogue')
  return data.pages.flatMap((p: unknown): CataloguePage[] => {
    if (!isObject(p) || !validAlias(p.alias) || typeof p.title !== 'string' ||
        typeof p.pageType !== 'string') return []
    return [{ alias: p.alias, pageType: p.pageType, title: p.title }]
  })
}

function plan(index: SourceIndex, catalogue: CataloguePage[]): {
  items: Item[]; skippedExisting: number; rejected: string[]
} {
  const grouped = aggregate(index.summaries)
  const already = new Map(catalogue.map((p) => [p.alias, p]))
  const taken = new Map<string, string>()
  const items: Item[] = []
  const rejected: string[] = []
  let skippedExisting = 0
  for (const [kind, groups] of ([['topic', grouped.topics], ['entity', grouped.entities]] as
    Array<[Kind, ConceptGroup[]]>)) {
    for (const group of groups) {
      const name = group.name.trim()
      if (name.length < 3 || name.length > 160 || /[\r\n<>]/.test(name) ||
          !group.rawSources.some(validAlias)) {
        rejected.push(`${kind}: ${name.slice(0, 70)} (unsafe title or missing raw evidence)`)
        continue
      }
      const alias = aliasFor(kind, name)
      const titleKey = `${kind}:${key(name)}`
      const collision = taken.get(alias)
      if (collision && collision !== titleKey) {
        rejected.push(`${kind}: ${name.slice(0, 70)} (alias collision: ${alias})`)
        continue
      }
      taken.set(alias, titleKey)
      const current = already.get(alias)
      if (current) {
        if (current.pageType === kind && key(current.title) === key(name)) skippedExisting++
        else rejected.push(`${kind}: ${name.slice(0, 70)} (registered alias owned by another page)`)
        continue
      }
      // Existing catalogue titles can have a different alias; preserve those pages.
      if (catalogue.some((p) => p.pageType === kind && key(p.title) === key(name))) {
        skippedExisting++
        continue
      }
      items.push({ kind, name, alias })
    }
  }
  return { items, skippedExisting, rejected }
}

type WikiMutation = {
  pageType: Kind; title: string; description: string; tags: string[];
  sourceAliases: string[]; body: string
}
const generateMutation = (
  item: Item,
  index: SourceIndex,
  topics: ConceptGroup[], entities: ConceptGroup[],
  pairs: Cooccurrence[],
  publishableAliases: Set<string>,
): WikiMutation => {
  const groups = item.kind === 'topic' ? topics : entities
  const group = groups.find((g) => key(g.name) === key(item.name))
  if (!group) throw new Error(`Index group missing during publish: ${item.name}`)
  const sourceAliases = group.rawSources.filter(validAlias)
    .filter((a) => !a.startsWith('memex-wiki-')).slice(0, 100)
  if (!sourceAliases.length) throw new Error(`No canonical evidence for ${item.alias}`)

  const excerpts: string[] = []
  for (const summary of index.summaries) {
    if (!group.summaries.includes(summary.alias)) continue
    const matches = item.kind === 'topic' ? summary.topics : summary.entities
    const evidence = matches.find((e) => key(e.name) === key(item.name))
    if (!evidence) continue
    const quote = safeMarkdown(evidence.quote).slice(0, 180)
    excerpts.push(`- [${safeMarkdown(summary.alias)}](/n/${summary.alias}) — evidence excerpt: “${quote}”`)
    if (excerpts.length >= 85) break
  }
  const related: string[] = []
  for (const pair of pairs) {
    const matched = item.kind === 'topic'
      ? key(pair.topic) === key(item.name)
      : key(pair.entity) === key(item.name)
    if (!matched) continue
    const name = item.kind === 'topic' ? pair.entity : pair.topic
    const targetAlias = aliasFor(item.kind === 'topic' ? 'entity' : 'topic', name)
    if (publishableAliases.has(targetAlias)) {
      related.push(`- [${safeMarkdown(name)}](/n/${targetAlias}) — ${pair.count} shared source summaries`)
    }
    if (related.length >= 80) break
  }
  const kindLabel = item.kind === 'topic' ? 'Topic' : 'Entity'
  const summaryCount = group.summaries.length
  const body = [
    `# ${kindLabel}: ${safeMarkdown(item.name)}`,
    '',
    '**LLM-generated OKF navigation from an operator-applied source index.** These are evidence navigation aids, not approved canonical `associated_with` relationships. Shared-source co-occurrence is not proof of a semantic relationship.',
    '',
    `Found in ${summaryCount} derived source summaries. Full source identities are in the YAML \`sources\` field.`,
    '',
    `## Supporting source summaries (${summaryCount})`,
    '',
    ...excerpts,
    ...(summaryCount > excerpts.length ? [`- ${summaryCount - excerpts.length} further source summaries are recorded in the OKF source-navigation index.`] : []),
    '',
    '## Co-occurrence navigation candidates (unapproved)',
    '',
    ...(related.length ? related : ['No source co-occurrence candidates for this label.']),
    '',
    'Related labels in this section share classified source summaries only. They have **not** been approved as semantic or canonical source–source relations.',
  ].join('\n').slice(0, 57_000)
  return {
    pageType: item.kind, title: item.name,
    description: `Source-grounded generated OKF ${kindLabel.toLowerCase()}; ${summaryCount} supporting source summaries. Co-occurrence links are unapproved navigation candidates.`.slice(0, 500),
    tags: ['okf-generated', 'source-grounded'], sourceAliases, body,
  }
}

// A bounded CNL nodeBook projection: the complete catalogue remains in the
// separately indexed Topic/Entity/Source pages. Do not merge this into the
// live Memex source-association graph or imply that shared sources are approved edges.
const graphMutation = (index: SourceIndex, catalogue: CataloguePage[]): {
  pageType: 'synthesis'; title: string; description: string;
  tags: string[]; sourceAliases: string[]; body: string
} => {
  const groups = aggregate(index.summaries)
  const indexed = (kind: Kind, name: string): string | null =>
    catalogue.find((p) => p.pageType === kind && key(p.title) === key(name))?.alias ?? null
  const validSummaries = new Set(catalogue.filter((p) => p.pageType === 'source-summary').map((p) => p.alias))
  const topTopics = groups.topics.filter((p) => indexed('topic', p.name) !== null).slice(0, 20)
  const byTopic = new Map<string, Cooccurrence[]>()
  for (const pair of groups.cooccurrences) {
    const k = key(pair.topic)
    const matches = byTopic.get(k) ?? []
    if (matches.length < 4) matches.push(pair)
    byTopic.set(k, matches)
  }
  const records = new Map<string, { label: string; edges: Set<string> }>()
  const node = (alias: string, label: string) => {
    const prior = records.get(alias)
    if (prior) return prior
    const value = { label, edges: new Set<string>() }
    records.set(alias, value)
    return value
  }
  const edge = (from: string, relation: string, target: string, label: string) => {
    node(from, from)
    node(target, label)
    records.get(from)!.edges.add(`<${relation}> ${safeMarkdown(label).slice(0, 90)} · ${target};`)
  }
  node('memex-index', 'Memex Index')
  edge('memex-index', 'okf_wiki_index_entry', 'memex-wiki-index', 'Maintained Memex Wiki Index')
  const chosen = new Set<string>()
  for (const topic of topTopics) {
    const t = indexed('topic', topic.name)!
    if (chosen.has(t)) continue
    chosen.add(t)
    edge('memex-wiki-index', 'okf_topic_navigation', t, topic.name)
    for (const summary of topic.summaries.slice(0, 2)) {
      const selected = index.summaries.find((s) => s.alias === summary)
      if (!selected || !validSummaries.has(summary)) continue
      edge(t, 'okf_supporting_summary', summary, summary)
      for (const raw of selected.rawAliases.slice(0, 1).filter(validAlias)) {
        edge(summary, 'okf_canonical_evidence', raw, raw)
      }
    }
    for (const pair of (byTopic.get(key(topic.name)) ?? [])) {
      const e = indexed('entity', pair.entity)
      if (e) {
        edge(t, 'okf_cooccurrence_unapproved', e, pair.entity)
        const evidenceSummary = pair.summaries.find((a) => validSummaries.has(a))
        if (evidenceSummary) {
          edge(e, 'okf_supporting_summary', evidenceSummary, evidenceSummary)
          const summaryRecord = index.summaries.find((r) => r.alias === evidenceSummary)
          const rawAlias = summaryRecord?.rawAliases.find(validAlias)
          if (rawAlias) edge(evidenceSummary, 'okf_canonical_evidence', rawAlias, rawAlias)
        }
      }
    }
  }
  const cnl = [...records.entries()].map(([alias, obj]) =>
    `# ${safeMarkdown(obj.label).slice(0, 120)}\nalias: ${alias};\n${[...obj.edges].join('\n')}`
  ).join('\n\n')
  const graph = [
    '# OKF Source Navigation Graph', '',
    '**Bounded nodeBook graph projection** from the applied OKF source index.',
    'This bounded visual begins at Memex Index, follows the maintained Wiki index to the 20 most-supported Topics, up to four co-occurring Entities per Topic, and supporting source summaries and canonical evidence.',
    'For complete coverage, browse individual [Topic and Entity pages](/memex-wiki). All source classifications remain in the persistent OKF navigation index.',
    '',
    '**Edge semantics:** `okf_cooccurrence_unapproved` means two labels occur in the same classified source summary. It is NOT an approved Topic–Entity link or a canonical `associated_with` relationship.',
    'The index, source summaries, and canonical evidence links are the navigation path; the nodeBook view does not modify the existing Memex association graph.',
    '',
    '```nodeBook', cnl, '```',
  ].join('\n')
  if (graph.length > 57_000) throw new Error('Bounded nodeBook graph exceeds Wiki page size; reduce graph fan-out')
  const rawSources = [...new Set(index.summaries.flatMap((item) => item.rawAliases))]
    .filter((value) => validAlias(value) && !value.startsWith('memex-wiki-')).slice(0, 20)
  if (!rawSources.length) throw new Error('Graph projection lacks canonical evidence aliases')
  return {
    pageType: 'synthesis', title: GRAPH_TITLE,
    description: 'Bounded nodeBook navigation graph: Wiki index to Topics, source-backed Entity co-occurrences, summaries, and canonical evidence (unapproved links explicitly marked).',
    tags: ['okf-generated', 'source-grounded', 'nodebook', 'navigation'],
    sourceAliases: rawSources, body: graph,
  }
}

const failure = (error: unknown): NextResponse => {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof RateLimited) return NextResponse.json(
    { error: message, retrySeconds: error.retrySeconds },
    { status: 429, headers: { 'Retry-After': String(error.retrySeconds) } },
  )
  return NextResponse.json({ error: message }, { status: /BUSY|STALE|wait|changed/i.test(message) ? 409 : 500 })
}

export async function GET(request: NextRequest) {
  if (!(await authorizedOkfOperator(request))) return NextResponse.json({ error: 'Operator session required' }, { status: 403 })
  try { return NextResponse.json(publicJob(await readJob()), { headers: { 'Cache-Control': 'no-store' } }) }
  catch (error) { return failure(error) }
}

export async function POST(request: NextRequest) {
  if (!(await authorizedOkfOperator(request)) || !sameOrigin(request)) {
    return NextResponse.json({ error: 'Operator session or Origin rejected' }, { status: 403 })
  }
  let input: Record<string, unknown>
  try {
    const parsed: unknown = await request.json()
    if (!isObject(parsed)) throw new Error('JSON object required')
    input = parsed
  } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  try {
    return NextResponse.json(await exclusive(async () => {
      if (!(await okfRelationsWriteEnabled())) throw new Error('OKF write flag disabled')
      if (input.action === 'prepare') {
        if (input.confirmation !== 'APPLY') throw new Error('Type APPLY to publish Wiki pages')
        const previous = await readJob()
        // A partially completed previous publication must be resumed, not reset.
        if (previous && previous.state !== 'completed') throw new Error('Existing publication must be resumed, not reset')
        const [{ index, revision }, catalogue] = await Promise.all([readSourceIndex(), readCatalogue()])
        if (!index || !index.summaries.length) throw new Error('Apply the OKF source index first')
        const drafted = plan(index, catalogue)
        const now = new Date().toISOString()
        const job: Job = {
          version: 1, id: randomBytes(16).toString('hex'),
          state: 'running',
          indexRevision: revision, indexSourceCount: index.summaries.length,
          createdAt: now, updatedAt: now, items: drafted.items, cursor: 0,
          created: 0, skippedExisting: drafted.skippedExisting,
          rejected: drafted.rejected, lastWriteAt: 0, graphState: 'pending',
        }
        await writeJob(job)
        return publicJob(job)
      }
      const job = await readJob()
      if (!job || input.id !== job.id) throw new Error('STALE_WIKI_PUBLISH_JOB')
      if (input.action === 'pause') {
        if (job.state === 'running') job.state = 'paused'
        job.updatedAt = new Date().toISOString()
        await writeJob(job)
        return publicJob(job)
      }
      if (input.action !== 'step') throw new Error('Unsupported publication action')
      if (job.state !== 'running' && job.state !== 'paused') throw new Error('Publication is not active')
      if (job.cursor > job.items.length) throw new Error('Publication cursor invalid')
      const wait = job.lastWriteAt + GAP_MS - Date.now()
      if (wait > 0) throw new RateLimited(Math.ceil(wait / 1000))
      const [{ index, revision }, catalogue] = await Promise.all([readSourceIndex(), readCatalogue()])
      if (!index || revision !== job.indexRevision) throw new Error('STALE: OKF source index changed; stop publishing')
      // Final publication step creates a bounded, separate nodeBook CNL graph
      // note. The ordinary Wiki index links to this page automatically.
      if (job.cursor === job.items.length) {
        const existingGraph = catalogue.find((page) => page.alias === GRAPH_ALIAS)
        if (existingGraph) {
          if (existingGraph.pageType !== 'synthesis' || key(existingGraph.title) !== key(GRAPH_TITLE)) {
            throw new Error(`STALE: ${GRAPH_ALIAS} is owned by another Wiki page`)
          }
          job.graphState = 'preserved' // never overwrite an existing graph page
        } else {
          if (catalogue.some((page) => page.pageType === 'synthesis' && key(page.title) === key(GRAPH_TITLE))) {
            throw new Error('STALE: navigation graph title is already registered under another alias')
          }
          const result = await requestJson(MAINTAIN_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              dryRun: false, provenance: `okf-nodebook-graph-${job.id}`,
              pages: [graphMutation(index, catalogue)],
            }),
          })
          if (result.committed !== true || result.count !== 1 ||
              !Array.isArray(result.pages) || !result.pages.some((page: unknown) =>
                isObject(page) && page.alias === GRAPH_ALIAS && page.created === true)) {
            throw new Error('Graph publication confirmation failed; inspect Wiki catalogue before retrying')
          }
          job.graphState = 'created'
        }
        job.state = 'completed'
        job.updatedAt = new Date().toISOString()
        job.lastWriteAt = Date.now()
        await writeJob(job)
        return publicJob(job)
      }
      const groups = aggregate(index.summaries)
      const catalogByAlias = new Map(catalogue.map((page) => [page.alias, page]))
      const planned = job.items.slice(job.cursor, job.cursor + MAX_STEP)
      const toCreate: Item[] = []
      let skipped = 0
      for (const item of planned) {
        const registered = catalogByAlias.get(item.alias)
        if (registered) {
          if (registered.pageType !== item.kind || key(registered.title) !== key(item.name)) {
            throw new Error(`STALE: Wiki alias collision, refusing overwrite ${item.alias}`)
          }
          skipped++
        } else { toCreate.push(item) }
      }
      const publishableAliases = new Set([...catalogByAlias.keys(), ...job.items.map((p) => p.alias)])
      if (toCreate.length) {
        const pages = toCreate.map((item) => generateMutation(item, index,
          groups.topics, groups.entities, groups.cooccurrences, publishableAliases))
        // The standard Wiki maintenance route owns generated-page mutations and
        // its catalogue update. It validates canonical sourceAliases and refuses
        // to overwrite aliases which are not registered derived Wiki pages.
        const result = await requestJson(MAINTAIN_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dryRun: false,
            provenance: `okf-source-navigation-${job.id}`,
            pages,
          }),
        })
        if (result.committed !== true || result.count !== pages.length) {
          throw new Error('Wiki maintenance did not confirm all generated pages; checkpoint unchanged')
        }
        const confirmedPages = Array.isArray(result.pages) ? result.pages : []
        if (confirmedPages.length !== pages.length ||
            toCreate.some((item) => !confirmedPages.some((p: unknown) =>
              isObject(p) && p.alias === item.alias && p.created === true))) {
          throw new Error('Wiki maintenance returned unexpected aliases; inspect Wiki catalogue before resuming')
        }
      }
      job.cursor += planned.length
      job.created += toCreate.length
      job.skippedExisting += skipped
      job.lastWriteAt = Date.now()
      job.updatedAt = new Date().toISOString()
      job.state = 'running' // next step publishes the nodeBook graph note
      await writeJob(job)
      return publicJob(job)
    }), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return failure(error) }
}
