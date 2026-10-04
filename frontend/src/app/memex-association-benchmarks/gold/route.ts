import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { readMemexApiToken } from '../../memex-revisions/_proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PROJECT_ROOT = process.env.MEMEX_PROJECT_ROOT ?? '/data/projects/hedgedoc'
const ROOT =
  process.env.MEMEX_ASSOCIATION_BENCHMARK_PATH ??
  join(PROJECT_ROOT, 'memex/benchmarks/association')
const LEGACY_GOLD_FILE =
  process.env.MEMEX_ASSOCIATION_BENCHMARK_GOLD_FILE ?? join(ROOT, 'gold.tsv')
const GOLD_DIR =
  process.env.MEMEX_ASSOCIATION_BENCHMARK_GOLD_DIR ?? join(ROOT, 'gold')
const HEDGEDOC_NOTES_API =
  process.env.HEDGEDOC_NOTES_API ?? 'http://127.0.0.1:3100/api/v2/notes'
const SNAPSHOTS_ALIAS = 'memex-snapshots'
const MEMEX_INDEX_PATH = process.env.MEMEX_INDEX_PATH ?? join(PROJECT_ROOT, 'memex/index.md')
const revisionPattern = /^[0-9a-f-]{16,64}$/i

const GOLD_HEADERS = [
  'source',
  'target',
  'gold_associated',
  'gold_strength',
  'gold_reason',
  'reviewed_by',
  'reviewed_at',
] as const

interface SnapshotSource {
  alias: string
  title: string
  revisionId: string
  summary: string
  llmSplit: boolean
  splitOrigins: string[]
}

interface SnapshotManifest {
  name?: string
  sources?: Array<{ alias?: string; title?: string; revisionId?: string }>
}

interface GoldPairPayload {
  source?: unknown
  target?: unknown
  goldAssociated?: unknown
  goldStrength?: unknown
  goldReason?: unknown
  reviewedBy?: unknown
  reviewedAt?: unknown
}

const jsonNoStore = (body: unknown, init?: ResponseInit) =>
  NextResponse.json(body, {
    ...init,
    headers: {
      'Cache-Control': 'no-store',
      ...(init?.headers ?? {}),
    },
  })

const parseTsvLine = (line: string): string[] => {
  const values: string[] = []
  let value = ''
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (char === '\t' && !quoted) {
      values.push(value)
      value = ''
      continue
    }
    value += char
  }
  values.push(value)
  return values
}

const parseTsv = (text: string): Record<string, string>[] => {
  const lines = text.split(/\r?\n/).filter(Boolean)
  if (!lines.length) return []
  const headers = parseTsvLine(lines[0])
  return lines.slice(1).map((line) => {
    const values = parseTsvLine(line)
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
  })
}

const tsvCell = (value: string): string => {
  if (!/[\t\r\n"]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

const serializeTsv = (rows: Record<string, string>[]): string => {
  const lines = [GOLD_HEADERS.join('\t')]
  for (const row of rows) {
    lines.push(GOLD_HEADERS.map((header) => tsvCell(row[header] ?? '')).join('\t'))
  }
  return `${lines.join('\n')}\n`
}

const pairKey = (left: string, right: string): string =>
  [left.trim(), right.trim()].sort().join('\u0000')

const parseGoldBoolean = (value: string): boolean | null => {
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return null
}

const readTextIfExists = async (path: string): Promise<string> => {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

const snapshotGoldPath = (snapshotRevision: string): string =>
  join(GOLD_DIR, `${snapshotRevision}.tsv`)

const indexedSourceSummaries = (indexText: string): Map<string, string> => {
  const summaries = new Map<string, string>()
  const sourcesMatch = indexText.match(/(?:^|\n)## Sources\s*\n([\s\S]*?)(?=\n##\s|$)/)
  if (!sourcesMatch) return summaries

  for (const line of sourcesMatch[1].split(/\r?\n/)) {
    const match = line.match(
      /^\s*-\s+\[[^\]]+\]\([^)]*\/n\/([^/?#)]+)[^)]*\)(?:\s+[—–-]\s*(.*))?\s*$/,
    )
    if (!match) continue
    const alias = decodeURIComponent(match[1].trim())
    const summary = (match[2] ?? '').replace(/\s+/g, ' ').trim()
    if (summary) summaries.set(alias, summary)
  }

  return summaries
}

const decodeYamlScalar = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

const normalizeSplitOrigin = (value: string): string =>
  decodeYamlScalar(value).replace(/[?#].*$/, '').replace(/\/$/, '')

const splitMetadata = (content: string): { llmSplit: boolean; splitOrigins: string[] } => {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)?.[1] ?? ''
  const blockValues = (key: string): string[] => {
    const match = frontmatter.match(new RegExp(`^${key}:\\s*\\n((?:[ \t]+-.*(?:\\n|$))*)`, 'm'))
    if (!match) return []
    return match[1]
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*-\s*(.*)$/)?.[1] ?? '')
      .map(decodeYamlScalar)
      .filter(Boolean)
  }
  const inlineTags = frontmatter.match(/^tags:\s*\[([^\]]*)\]/m)?.[1]
    ?.split(',')
    .map((tag) => decodeYamlScalar(tag))
    .filter(Boolean) ?? []
  const tags = [...blockValues('tags'), ...inlineTags].map((tag) => tag.toLowerCase())
  return {
    llmSplit: tags.includes('llm-split'),
    splitOrigins: Array.from(new Set(blockValues('sources').map(normalizeSplitOrigin).filter(Boolean))),
  }
}

const splitPairInfo = (source: SnapshotSource, target: SnapshotSource) => {
  if (!source.llmSplit || !target.llmSplit) return { associated: false, origin: '' }
  const targetOrigins = new Set(target.splitOrigins)
  const origin = source.splitOrigins.find((candidate) => targetOrigins.has(candidate)) ?? ''
  return { associated: Boolean(origin), origin }
}

const splitGoldReason =
  'Automatically associated: both notes were produced by the same LLM split source.'

const fetchRevisionContent = async (
  alias: string,
  revisionId: string,
  token: string,
): Promise<string> => {
  const response = await fetch(
    `${HEDGEDOC_NOTES_API}/${encodeURIComponent(alias)}/revisions/${encodeURIComponent(revisionId)}`,
    {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` },
    },
  )
  if (!response.ok) {
    throw new Error(`HedgeDoc revision request failed for ${alias} (${response.status})`)
  }
  const revision = (await response.json()) as { content?: string }
  if (typeof revision.content !== 'string') {
    throw new Error(`HedgeDoc revision ${revisionId} for ${alias} has no content`)
  }
  return revision.content
}

const loadSnapshot = async (snapshotRevision: string) => {
  if (!revisionPattern.test(snapshotRevision)) {
    throw new Error('Invalid snapshot revision')
  }

  const token = await readMemexApiToken()
  const response = await fetch(
    `${HEDGEDOC_NOTES_API}/${encodeURIComponent(SNAPSHOTS_ALIAS)}/revisions/${encodeURIComponent(snapshotRevision)}`,
    {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` },
    },
  )
  if (!response.ok) {
    throw new Error(`HedgeDoc snapshot revision request failed (${response.status})`)
  }

  const revision = (await response.json()) as { content?: string }
  if (typeof revision.content !== 'string') {
    throw new Error('Selected HedgeDoc snapshot revision has no content')
  }

  const match = revision.content.match(
    /## Source Manifest[\s\S]*?```json\s*([\s\S]*?)```/i,
  )
  if (!match) {
    throw new Error('Selected revision does not contain a Source Manifest')
  }

  const manifest = JSON.parse(match[1]) as SnapshotManifest
  if (!Array.isArray(manifest.sources) || manifest.sources.length < 2) {
    throw new Error('Selected snapshot contains fewer than two sources')
  }

  const rawSources = manifest.sources.map((source) => {
    const alias = (source.alias ?? '').trim()
    const revisionId = (source.revisionId ?? '').trim()
    if (!alias || !revisionPattern.test(revisionId)) {
      throw new Error('Snapshot contains an invalid source manifest entry')
    }
    return {
      alias,
      title: (source.title ?? alias).trim() || alias,
      revisionId,
    }
  })

  const summaries = indexedSourceSummaries(await readTextIfExists(MEMEX_INDEX_PATH))
  const sources: SnapshotSource[] = await Promise.all(
    rawSources.map(async (source) => {
      const content = await fetchRevisionContent(source.alias, source.revisionId, token)
      return {
        ...source,
        summary:
          summaries.get(source.alias) ??
          'No current Memex index summary is available for this source.',
        ...splitMetadata(content),
      }
    }),
  )

  return {
    snapshotName: manifest.name ?? '',
    sources,
  }
}

const expectedPairKeys = (sources: SnapshotSource[]): Set<string> => {
  const result = new Set<string>()
  for (let left = 0; left < sources.length; left += 1) {
    for (let right = left + 1; right < sources.length; right += 1) {
      result.add(pairKey(sources[left].alias, sources[right].alias))
    }
  }
  return result
}

const pairSetForRows = (rows: Record<string, string>[]): Set<string> => {
  const result = new Set<string>()
  for (const row of rows) {
    const source = (row.source ?? '').trim()
    const target = (row.target ?? '').trim()
    if (source && target) result.add(pairKey(source, target))
  }
  return result
}

const samePairSet = (left: Set<string>, right: Set<string>): boolean =>
  left.size === right.size && [...left].every((key) => right.has(key))

const readGoldRows = async (snapshotRevision: string, expected: Set<string>) => {
  const snapshotPath = snapshotGoldPath(snapshotRevision)
  const snapshotText = await readTextIfExists(snapshotPath)
  if (snapshotText) {
    return {
      rows: parseTsv(snapshotText),
      path: snapshotPath,
      storage: 'snapshot' as const,
    }
  }

  const legacyText = await readTextIfExists(LEGACY_GOLD_FILE)
  if (legacyText) {
    const legacyRows = parseTsv(legacyText)
    if (samePairSet(pairSetForRows(legacyRows), expected)) {
      return {
        rows: legacyRows,
        path: LEGACY_GOLD_FILE,
        storage: 'legacy-fallback' as const,
      }
    }
  }

  return {
    rows: [] as Record<string, string>[],
    path: snapshotPath,
    storage: 'new' as const,
  }
}

const goldStatus = (
  expected: Set<string>,
  rows: Record<string, string>[],
) => {
  const present = pairSetForRows(rows)
  let labeled = 0
  let invalid = 0

  for (const row of rows) {
    const source = (row.source ?? '').trim()
    const target = (row.target ?? '').trim()
    if (!source || !target || !expected.has(pairKey(source, target))) continue
    const parsed = parseGoldBoolean(row.gold_associated ?? '')
    if (parsed === null) invalid += 1
    else labeled += 1
  }

  const missing = [...expected].filter((key) => !present.has(key)).length
  const extra = [...present].filter((key) => !expected.has(key)).length
  const unlabeled = Math.max(0, expected.size - labeled)
  const ready =
    missing === 0 &&
    extra === 0 &&
    invalid === 0 &&
    present.size === expected.size &&
    labeled === expected.size

  return {
    ready,
    pairsExpected: expected.size,
    pairsPresent: present.size,
    pairsLabeled: labeled,
    unlabeled,
    invalid,
    missing,
    extra,
  }
}

const buildPairs = (
  sources: SnapshotSource[],
  rows: Record<string, string>[],
) => {
  const byKey = new Map(
    rows.map((row) => [pairKey(row.source ?? '', row.target ?? ''), row]),
  )
  const pairs = []
  for (let left = 0; left < sources.length; left += 1) {
    for (let right = left + 1; right < sources.length; right += 1) {
      const source = sources[left]
      const target = sources[right]
      const row = byKey.get(pairKey(source.alias, target.alias)) ?? {}
      const splitPair = splitPairInfo(source, target)
      const storedAssociated = parseGoldBoolean(row.gold_associated ?? '')
      const autoApplied =
        splitPair.associated &&
        (storedAssociated !== true || row.gold_strength !== '1' || row.gold_reason !== splitGoldReason)
      pairs.push({
        source: source.alias,
        sourceTitle: source.title,
        target: target.alias,
        targetTitle: target.title,
        goldAssociated: splitPair.associated ? true : storedAssociated,
        goldStrength: splitPair.associated ? '1' : row.gold_strength ?? '',
        goldReason: splitPair.associated ? splitGoldReason : row.gold_reason ?? '',
        reviewedBy: splitPair.associated ? row.reviewed_by || 'llm-split-auto' : row.reviewed_by ?? '',
        reviewedAt: row.reviewed_at ?? '',
        llmSplitAssociated: splitPair.associated,
        splitOrigin: splitPair.origin,
        autoApplied,
      })
    }
  }
  return pairs
}

const normalizeText = (value: unknown, maxLength: number): string =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : ''

const normalizeStrength = (value: unknown): string => {
  if (value === '' || value === null || value === undefined) return ''
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error('Gold strength must be blank or a number from 0 to 1')
  }
  return String(number)
}

export async function GET(request: NextRequest) {
  try {
    const snapshotRevision =
      request.nextUrl.searchParams.get('snapshotRevision')?.trim() ?? ''
    if (!revisionPattern.test(snapshotRevision)) {
      return jsonNoStore({ error: 'A valid snapshotRevision is required' }, { status: 400 })
    }

    const { snapshotName, sources } = await loadSnapshot(snapshotRevision)
    const expected = expectedPairKeys(sources)
    const gold = await readGoldRows(snapshotRevision, expected)

    const pairs = buildPairs(sources, gold.rows)
    return jsonNoStore({
      snapshotRevision,
      snapshotName,
      sources,
      pairs,
      autoApplied: pairs.filter((pair) => pair.autoApplied).length,
      status: goldStatus(expected, gold.rows),
      path: gold.path,
      storage: gold.storage,
    })
  } catch (error) {
    return jsonNoStore(
      { error: error instanceof Error ? error.message : 'Unable to load benchmark gold review' },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      snapshotRevision?: unknown
      reviewer?: unknown
      pairs?: unknown
    }
    const snapshotRevision =
      typeof body.snapshotRevision === 'string' ? body.snapshotRevision.trim() : ''
    if (!revisionPattern.test(snapshotRevision)) {
      return jsonNoStore({ error: 'A valid snapshotRevision is required' }, { status: 400 })
    }
    if (!Array.isArray(body.pairs)) {
      return jsonNoStore({ error: 'pairs must be an array' }, { status: 400 })
    }

    const { snapshotName, sources } = await loadSnapshot(snapshotRevision)
    const expected = expectedPairKeys(sources)
    const submitted = body.pairs as GoldPairPayload[]
    const seen = new Set<string>()
    const now = new Date().toISOString()
    const reviewer = normalizeText(body.reviewer, 120) || 'human-ui'
    const rows: Record<string, string>[] = []
    const sourceByAlias = new Map(sources.map((source) => [source.alias, source]))

    for (const pair of submitted) {
      const source = normalizeText(pair.source, 220)
      const target = normalizeText(pair.target, 220)
      if (!source || !target) {
        throw new Error('Every gold pair requires source and target aliases')
      }
      const key = pairKey(source, target)
      if (!expected.has(key)) {
        throw new Error(`Gold pair is not part of the selected snapshot: ${source} ↔ ${target}`)
      }
      if (seen.has(key)) {
        throw new Error(`Duplicate gold pair submitted: ${source} ↔ ${target}`)
      }
      seen.add(key)

      const sourceInfo = sourceByAlias.get(source)
      const targetInfo = sourceByAlias.get(target)
      if (!sourceInfo || !targetInfo) {
        throw new Error(`Gold pair references an unknown snapshot source: ${source} ↔ ${target}`)
      }
      const splitPair = splitPairInfo(sourceInfo, targetInfo)

      let goldAssociated = ''
      if (splitPair.associated) goldAssociated = 'true'
      else if (pair.goldAssociated === true) goldAssociated = 'true'
      else if (pair.goldAssociated === false) goldAssociated = 'false'
      else if (pair.goldAssociated !== null && pair.goldAssociated !== undefined) {
        throw new Error('goldAssociated must be true, false, or null')
      }

      const goldStrength = splitPair.associated
        ? '1'
        : normalizeStrength(pair.goldStrength)
      const goldReason = splitPair.associated
        ? splitGoldReason
        : normalizeText(pair.goldReason, 1200)
      const reviewedBy = splitPair.associated
        ? 'llm-split-auto'
        : normalizeText(pair.reviewedBy, 120) || reviewer

      rows.push({
        source,
        target,
        gold_associated: goldAssociated,
        gold_strength: goldStrength,
        gold_reason: goldReason,
        reviewed_by: goldAssociated ? reviewedBy : '',
        reviewed_at: goldAssociated
          ? normalizeText(pair.reviewedAt, 80) || now
          : '',
      })
    }

    if (seen.size !== expected.size) {
      return jsonNoStore(
        {
          error: `Gold review must contain all ${expected.size} snapshot pairs; received ${seen.size}.`,
        },
        { status: 409 },
      )
    }

    const outputPath = snapshotGoldPath(snapshotRevision)
    await mkdir(dirname(outputPath), { recursive: true })
    const tempPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tempPath, serializeTsv(rows), 'utf8')
    await rename(tempPath, outputPath)

    const status = goldStatus(expected, rows)
    return jsonNoStore({
      snapshotRevision,
      snapshotName,
      sources,
      pairs: buildPairs(sources, rows),
      status,
      path: outputPath,
      storage: 'snapshot',
    })
  } catch (error) {
    return jsonNoStore(
      { error: error instanceof Error ? error.message : 'Unable to save benchmark gold review' },
      { status: 500 },
    )
  }
}
