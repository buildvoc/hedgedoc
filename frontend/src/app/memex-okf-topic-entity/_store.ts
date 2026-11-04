import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const RELATIONS_PATH =
  process.env.MEMEX_OKF_TOPIC_ENTITY_PATH ??
  '/data/projects/hedgedoc/memex/wiki_topic_entity_relations.json'

export type TopicEntityRelation = {
  relation: 'includes_entity'
  topicAlias: string
  entityAlias: string
  rationale: string
  approvedAt: string
}

type RelationshipDocument = {
  version: 1
  updatedAt: string
  relations: TopicEntityRelation[]
}

const EMPTY: RelationshipDocument = { version: 1, updatedAt: '', relations: [] }

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

const isRelation = (r: unknown): r is TopicEntityRelation => {
  if (!r || typeof r !== 'object') return false
  const e = r as Partial<TopicEntityRelation>
  return e.relation === 'includes_entity' &&
    typeof e.topicAlias === 'string' && /^memex-wiki-topic-[a-z0-9_-]+$/.test(e.topicAlias) &&
    typeof e.entityAlias === 'string' && /^memex-wiki-entity-[a-z0-9_-]+$/.test(e.entityAlias) &&
    typeof e.rationale === 'string' && e.rationale.length >= 8 &&
    typeof e.approvedAt === 'string'
}

export async function readOkfRelations(): Promise<{
  document: RelationshipDocument
  revision: string
}> {
  let raw = ''
  try {
    raw = await readFile(RELATIONS_PATH, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { document: { ...EMPTY, relations: [] }, revision: sha('') }
  }
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid OKF relationship file')
  const value = parsed as Partial<RelationshipDocument>
  if (value.version !== 1 || !Array.isArray(value.relations) ||
    !value.relations.every(isRelation) || typeof value.updatedAt !== 'string') {
    throw new Error('Invalid OKF relationship file schema; refusing writes')
  }
  const keys = value.relations.map((e) => `${e.topicAlias}\u0000${e.entityAlias}`)
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate OKF relationships in file')
  return { document: value as RelationshipDocument, revision: sha(raw) }
}

// File-level lock + revision precondition + atomic replace. Other writers must
// use this API. In a crash the stale .lock needs operator investigation.
export async function addOkfRelation(
  entry: Omit<TopicEntityRelation, 'approvedAt' | 'relation'>,
  expectedRevision: string,
): Promise<TopicEntityRelation[]> {
  await mkdir(dirname(RELATIONS_PATH), { recursive: true })
  const lockPath = `${RELATIONS_PATH}.lock`
  const handle = await open(lockPath, 'wx', 0o600)
  let tempPath = ''
  try {
    const { document, revision } = await readOkfRelations()
    if (revision !== expectedRevision) throw new Error('STALE_RELATIONS')
    if (document.relations.some((item) =>
      item.topicAlias === entry.topicAlias && item.entityAlias === entry.entityAlias)) {
      throw new Error('DUPLICATE_RELATION')
    }
    const relation: TopicEntityRelation = {
      relation: 'includes_entity',
      ...entry,
      approvedAt: new Date().toISOString(),
    }
    const next: RelationshipDocument = {
      version: 1,
      updatedAt: relation.approvedAt,
      relations: [...document.relations, relation],
    }
    tempPath = `${RELATIONS_PATH}.tmp-${randomUUID()}`
    await writeFile(tempPath, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    if (revision !== sha('')) {
      await copyFile(RELATIONS_PATH, `${RELATIONS_PATH}.bak-${Date.now()}`)
    }
    await rename(tempPath, RELATIONS_PATH)
    tempPath = ''
    return next.relations
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => {})
    await handle.close()
    await unlink(lockPath)
  }
}

/** Add a reviewed LLM preview as ONE atomic relationship-store update.
 * Existing human-approved links are never removed or rewritten.
 */
export async function addOkfRelationsBatch(
  entries: Array<Omit<TopicEntityRelation, 'approvedAt' | 'relation'>>,
  expectedRevision: string,
): Promise<{ added: number; total: number }> {
  if (entries.length > 2000) throw new Error('Batch too large')
  await mkdir(dirname(RELATIONS_PATH), { recursive: true })
  const handle = await open(`${RELATIONS_PATH}.lock`, 'wx', 0o600)
  let tempPath = ''
  try {
    const { document, revision } = await readOkfRelations()
    if (revision !== expectedRevision) throw new Error('STALE_RELATIONS')
    const known = new Set(document.relations.map((r) => `${r.topicAlias}\u0000${r.entityAlias}`))
    const now = new Date().toISOString()
    const fresh: TopicEntityRelation[] = []
    for (const entry of entries) {
      const key = `${entry.topicAlias}\u0000${entry.entityAlias}`
      if (known.has(key)) continue
      const relation: TopicEntityRelation = {
        relation: 'includes_entity', topicAlias: entry.topicAlias,
        entityAlias: entry.entityAlias, rationale: entry.rationale,
        approvedAt: now,
      }
      if (!isRelation(relation)) throw new Error('Invalid batch relationship')
      known.add(key)
      fresh.push(relation)
    }
    if (fresh.length === 0) return { added: 0, total: document.relations.length }
    const next: RelationshipDocument = {
      version: 1, updatedAt: now,
      relations: [...document.relations, ...fresh],
    }
    tempPath = `${RELATIONS_PATH}.tmp-${randomUUID()}`
    await writeFile(tempPath, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    if (revision !== sha('')) {
      await copyFile(RELATIONS_PATH, `${RELATIONS_PATH}.bak-${Date.now()}`)
    }
    await rename(tempPath, RELATIONS_PATH)
    tempPath = ''
    return { added: fresh.length, total: next.relations.length }
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => {})
    await handle.close()
    await unlink(`${RELATIONS_PATH}.lock`)
  }
}
