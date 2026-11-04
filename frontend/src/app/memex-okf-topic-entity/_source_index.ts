import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const INDEX_PATH = process.env.MEMEX_OKF_SOURCE_INDEX_PATH ??
  '/data/projects/hedgedoc/memex/okf_source_navigation.json'
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

export type ConceptEvidence = { name: string; quote: string; confidence: number }
export type ClassifiedSummary = {
  alias: string
  rawAliases: string[]
  topics: ConceptEvidence[]
  entities: ConceptEvidence[]
}
export type SourceIndex = {
  version: 1
  updatedAt: string
  sourceSnapshotHash: string
  model: string
  provider: string
  summaries: ClassifiedSummary[]
}

export async function readSourceIndex(): Promise<{ index: SourceIndex | null; revision: string }> {
  let raw = ''
  try { raw = await readFile(INDEX_PATH, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { index: null, revision: sha('') }
    throw error
  }
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object') throw new Error('Invalid stored OKF source navigation')
  const index = value as SourceIndex
  if (index.version !== 1 || !Array.isArray(index.summaries) ||
      !index.summaries.every((entry) => typeof entry.alias === 'string' &&
        Array.isArray(entry.rawAliases) && Array.isArray(entry.topics) && Array.isArray(entry.entities)) ||
      typeof index.sourceSnapshotHash !== 'string') {
    throw new Error('Unrecognized OKF source navigation schema; refusing overwrite')
  }
  return { index, revision: sha(raw) }
}

/** Atomically replace ONLY the LLM-generated source navigation index.
 * Independently approved Topic–Entity links and canonical source associations
 * are untouched. All index writers must use this file lock and revision check.
 */
export async function writeSourceIndex(index: SourceIndex, expectedRevision: string): Promise<void> {
  await mkdir(dirname(INDEX_PATH), { recursive: true })
  const lockPath = `${INDEX_PATH}.lock`
  const lock = await open(lockPath, 'wx', 0o600)
  let tmp = ''
  try {
    const current = await readSourceIndex()
    if (current.revision !== expectedRevision) throw new Error('STALE_OKF_SOURCE_INDEX')
    tmp = `${INDEX_PATH}.tmp-${randomUUID()}`
    await writeFile(tmp, JSON.stringify(index, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    if (current.index) await copyFile(INDEX_PATH, `${INDEX_PATH}.bak-${Date.now()}`)
    await rename(tmp, INDEX_PATH)
    tmp = ''
  } finally {
    if (tmp) await unlink(tmp).catch(() => undefined)
    await lock.close()
    await unlink(lockPath)
  }
}

export type ConceptGroup = { name: string; count: number; summaries: string[]; rawSources: string[] }
export type Cooccurrence = { topic: string; entity: string; count: number; summaries: string[] }

const key = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()

export function aggregate(summaries: ClassifiedSummary[]): {
  topics: ConceptGroup[]; entities: ConceptGroup[]; cooccurrences: Cooccurrence[]
} {
  const topics = new Map<string, ConceptGroup>()
  const entities = new Map<string, ConceptGroup>()
  const cooccurrences = new Map<string, Cooccurrence>()
  for (const summary of summaries) {
    const feed = (items: ConceptEvidence[], table: Map<string, ConceptGroup>) => {
      for (const item of items) {
        const k = key(item.name)
        const group = table.get(k) ?? { name: item.name, count: 0, summaries: [], rawSources: [] }
        if (!group.summaries.includes(summary.alias)) {
          group.count++
          group.summaries.push(summary.alias)
          group.rawSources = [...new Set([...group.rawSources, ...summary.rawAliases])]
        }
        table.set(k, group)
      }
    }
    feed(summary.topics, topics)
    feed(summary.entities, entities)
    for (const topic of summary.topics) for (const entity of summary.entities) {
      const k = `${key(topic.name)}\u0000${key(entity.name)}`
      const pair = cooccurrences.get(k) ?? {
        topic: topic.name, entity: entity.name, count: 0, summaries: [],
      }
      if (!pair.summaries.includes(summary.alias)) {
        pair.count++
        pair.summaries.push(summary.alias)
      }
      cooccurrences.set(k, pair)
    }
  }
  const sort = <T extends { count: number }>(values: T[]) => values.sort((a, b) => b.count - a.count)
  return {
    topics: sort([...topics.values()]),
    entities: sort([...entities.values()]),
    // Co-occurrence is a navigation candidate, not a verified semantic relation.
    cooccurrences: sort([...cooccurrences.values()]),
  }
}
