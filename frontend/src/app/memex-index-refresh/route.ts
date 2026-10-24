import { createHash } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'

import { NextRequest } from 'next/server'

import { readMemexApiToken } from '../memex-revisions/_proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MEMEX_INDEX_PATH =
  process.env.MEMEX_INDEX_PATH ?? '/data/projects/hedgedoc/memex/index.md'
const HEDGEDOC_NOTES_API =
  process.env.MEMEX_HEDGEDOC_API_BASE ?? 'http://127.0.0.1:3100/api/v2/notes'
const WIKI_INDEX_ALIAS =
  process.env.MEMEX_WIKI_INDEX_ALIAS ?? 'memex-wiki-index'
const MEMEX_INDEX_ALIAS =
  process.env.MEMEX_INDEX_ALIAS ?? 'memex-index'
const BACKUP_ROOT =
  process.env.MEMEX_BACKUP_DIR ?? '/backups/builds'
const PUBLIC_BASE =
  (process.env.MEMEX_PUBLIC_BASE ?? 'http://192.168.1.142:8180').replace(/\/+$/, '')
const REQUEST_GAP_MS = Math.max(
  1000,
  Number(process.env.MEMEX_INDEX_REFRESH_REQUEST_GAP_MS ?? '2100') || 2100
)

interface WikiIndexEntry {
  alias: string
  pageType: string
  title: string
  description: string
}

interface CleanupMigration {
  oldAlias?: unknown
  newAlias?: unknown
  sourceAlias?: unknown
}

interface CleanupManifest {
  createdAt?: unknown
  planHash?: unknown
  migrations?: unknown
}

interface SourceCandidate {
  sourceAlias: string
  pageAlias: string
  title: string
  summary: string
  canonical: boolean
}

interface RefreshPlan {
  indexMarkdown: string
  indexHash: string
  wikiIndexMarkdown: string
  wikiIndexHash: string
  cleanupManifestPath: string
  resultMarkdown: string
  currentSourceAliases: string[]
  wikiSourceAliases: string[]
  missing: SourceCandidate[]
  preservedExtraAliases: string[]
  sourceSummaryCount: number
  noSourceSummaryCount: number
  multiSourceSummaryCount: number
  unresolvedFetchedCount: number
  trailCount: number
  trailsHash: string
  resultSourceCount: number
  planHash: string
}

type ProgressWriter = (line?: string) => void

let nextHedgeDocRequestAt = 0

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const waitForHedgeDocSlot = async (
  signal?: AbortSignal
): Promise<void> => {
  const now = Date.now()
  const scheduled = Math.max(now, nextHedgeDocRequestAt)
  nextHedgeDocRequestAt = scheduled + REQUEST_GAP_MS

  if (scheduled <= now) return

  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Request cancelled'))
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, scheduled - now)

    const abort = () => {
      clearTimeout(timer)
      reject(new Error('Request cancelled'))
    }

    signal?.addEventListener('abort', abort, { once: true })
  })
}

const rateLimitDelayMs = (
  response: Response,
  detail: string
): number => {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000 + 5000
    }

    const retryDate = Date.parse(retryAfter)
    if (Number.isFinite(retryDate)) {
      return Math.max(5000, retryDate - Date.now() + 5000)
    }
  }

  const minutes = detail.match(/(\d+)\s+minutes?/i)
  if (minutes) return Number(minutes[1]) * 60_000 + 5000

  const seconds = detail.match(/(\d+)\s+seconds?/i)
  if (seconds) return Number(seconds[1]) * 1000 + 5000

  return 60_000
}

const hashText = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex')

const apiHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`
})

const retryableStatus = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status >= 500

const normalizeAlias = (value: string): string => {
  const alias = value.trim()
  return /^[A-Za-z0-9_-]{1,160}$/.test(alias) ? alias : ''
}

const deterministicSourceSummaryAlias = (sourceAlias: string): string => {
  const candidate = `memex-wiki-source-summary-${sourceAlias}`
  if (candidate.length <= 160) return candidate

  const digest = hashText(sourceAlias).slice(0, 12)
  return `${candidate.slice(0, 147)}-${digest}`
}

const fetchNote = async (
  alias: string,
  token: string,
  signal?: AbortSignal
): Promise<string> => {
  let lastError = ''

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    if (signal?.aborted) throw new Error('Request cancelled')

    try {
      await waitForHedgeDocSlot(signal)

      const response = await fetch(
        `${HEDGEDOC_NOTES_API}/${encodeURIComponent(alias)}/content`,
        {
          cache: 'no-store',
          headers: apiHeaders(token),
          signal
        }
      )

      if (response.ok) return response.text()

      const detail = await response.text()
      lastError =
        `HedgeDoc GET ${alias} failed (${response.status})` +
        (detail ? `: ${detail.slice(0, 240)}` : '')

      if (response.status === 429 && attempt < 5) {
        await sleep(rateLimitDelayMs(response, detail))
        continue
      }

      if (!retryableStatus(response.status)) break
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error instanceof Error ? error.message : String(error)
    }

    if (attempt < 5) await sleep(attempt * 500)
  }

  throw new Error(lastError || `HedgeDoc GET ${alias} failed`)
}

const putNote = async (
  alias: string,
  markdown: string,
  token: string
): Promise<void> => {
  let lastError = ''

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await waitForHedgeDocSlot()

    const response = await fetch(
      `${HEDGEDOC_NOTES_API}/${encodeURIComponent(alias)}`,
      {
        method: 'PUT',
        cache: 'no-store',
        headers: {
          ...apiHeaders(token),
          'Content-Type': 'text/markdown'
        },
        body: markdown
      }
    )

    if (response.ok) return

    const detail = await response.text()
    lastError =
      `HedgeDoc PUT ${alias} failed (${response.status})` +
      (detail ? `: ${detail.slice(0, 240)}` : '')

    if (response.status === 429 && attempt < 5) {
      await sleep(rateLimitDelayMs(response, detail))
      continue
    }

    if (!retryableStatus(response.status)) break
    if (attempt < 5) await sleep(attempt * 600)
  }

  throw new Error(lastError || `HedgeDoc PUT ${alias} failed`)
}

const parseWikiIndex = (markdown: string): WikiIndexEntry[] => {
  const entries: WikiIndexEntry[] = []

  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(
      /^- \[([^\]]+)\]\([^)]*\/n\/([^/?#)]+)\) — `([^`]+)` — (.+)$/
    )
    if (!match) continue

    const alias = normalizeAlias(decodeURIComponent(match[2]))
    if (!alias) continue

    entries.push({
      title: match[1].trim(),
      alias,
      pageType: match[3].trim(),
      description: match[4].trim()
    })
  }

  return entries
}

const sourceAliasesFromMarkdown = (markdown: string): string[] => {
  const frontmatter =
    markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''

  const sourceBlock =
    frontmatter.match(
      /^sources:\s*\r?\n((?:\s+-\s+.*(?:\r?\n|$))*)/m
    )?.[1] ?? ''

  return [
    ...new Set(
      Array.from(
        sourceBlock.matchAll(/\/(?:n|p|s)\/([A-Za-z0-9_-]+)/g),
        (match) => match[1]
      )
    )
  ]
}

const sourceSectionBounds = (
  markdown: string
): {
  headerEnd: number
  trailsStart: number
  trailsBlock: string
  sourceBody: string
} => {
  const sourceHeading = /^## Sources\s*$/m.exec(markdown)
  if (!sourceHeading || sourceHeading.index === undefined) {
    throw new Error('memex/index.md has no ## Sources section')
  }

  const afterSourceHeading =
    markdown.indexOf('\n', sourceHeading.index + sourceHeading[0].length)

  if (afterSourceHeading < 0) {
    throw new Error('memex/index.md Sources heading has no body')
  }

  const trailSearchStart = afterSourceHeading + 1
  const trailRelative = /^## Trails\s*$/m.exec(
    markdown.slice(trailSearchStart)
  )
  if (!trailRelative || trailRelative.index === undefined) {
    throw new Error('memex/index.md has no ## Trails section')
  }

  const trailsStart = trailSearchStart + trailRelative.index

  return {
    headerEnd: trailSearchStart,
    trailsStart,
    trailsBlock: markdown.slice(trailsStart),
    sourceBody: markdown.slice(trailSearchStart, trailsStart)
  }
}

const sourceAliasesFromIndex = (markdown: string): string[] => {
  const { sourceBody } = sourceSectionBounds(markdown)
  const seen = new Set<string>()

  for (const line of sourceBody.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('- [')) continue

    const match = line.match(
      /\/(?:n|p|s)\/([A-Za-z0-9_-]{1,160})(?:[?#][^)]*)?\)/
    )
    if (!match) continue
    seen.add(match[1])
  }

  return [...seen]
}

const trailCountFromBlock = (trailsBlock: string): number =>
  Array.from(trailsBlock.matchAll(/^###\s+.+$/gm)).length

const cleanInlineText = (value: string, fallback: string): string => {
  const cleaned = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned || fallback
}

const cleanLinkLabel = (value: string, fallback: string): string =>
  cleanInlineText(value, fallback)
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')

const renderSourceLine = (candidate: SourceCandidate): string =>
  `- [${cleanLinkLabel(candidate.title, candidate.sourceAlias)}](` +
  `${PUBLIC_BASE}/n/${encodeURIComponent(candidate.sourceAlias)}) — ` +
  `${cleanInlineText(candidate.summary, 'Source indexed from Memex Wiki.')}`

const loadLatestCleanupManifest = async (): Promise<{
  path: string
  aliasToSource: Map<string, string>
}> => {
  let names: string[] = []

  try {
    names = (await readdir(BACKUP_ROOT, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.startsWith('memex-source-summary-cleanup-')
      )
      .map((entry) => entry.name)
      .sort()
      .reverse()
  } catch (error) {
    throw new Error(
      `Unable to list cleanup snapshots under ${BACKUP_ROOT}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    )
  }

  for (const name of names) {
    const manifestPath = path.join(BACKUP_ROOT, name, 'manifest.json')

    try {
      const parsed = JSON.parse(
        await readFile(manifestPath, 'utf8')
      ) as CleanupManifest

      if (!Array.isArray(parsed.migrations)) continue

      const aliasToSource = new Map<string, string>()

      for (const item of parsed.migrations as CleanupMigration[]) {
        const oldAlias =
          typeof item.oldAlias === 'string'
            ? normalizeAlias(item.oldAlias)
            : ''
        const newAlias =
          typeof item.newAlias === 'string'
            ? normalizeAlias(item.newAlias)
            : ''
        const sourceAlias =
          typeof item.sourceAlias === 'string'
            ? normalizeAlias(item.sourceAlias)
            : ''

        if (!sourceAlias) continue
        if (oldAlias) aliasToSource.set(oldAlias, sourceAlias)
        if (newAlias) aliasToSource.set(newAlias, sourceAlias)
      }

      if (aliasToSource.size > 0) {
        return {
          path: manifestPath,
          aliasToSource
        }
      }
    } catch {
      // Try the next older cleanup snapshot.
    }
  }

  throw new Error(
    'No usable source-summary cleanup manifest was found. ' +
    'The refresh intentionally refuses a 300+ note fallback scan.'
  )
}

const chooseCandidate = (
  current: SourceCandidate | undefined,
  next: SourceCandidate
): SourceCandidate => {
  if (!current) return next
  if (next.canonical && !current.canonical) return next
  if (current.canonical && !next.canonical) return current

  return next.pageAlias.localeCompare(current.pageAlias) < 0
    ? next
    : current
}

const buildRefreshPlan = async (
  token: string,
  signal: AbortSignal | undefined,
  write: ProgressWriter
): Promise<RefreshPlan> => {
  write(`reading ${MEMEX_INDEX_PATH}…`)
  const indexMarkdown = await readFile(MEMEX_INDEX_PATH, 'utf8')
  const indexHash = hashText(indexMarkdown)
  const currentSourceAliases = sourceAliasesFromIndex(indexMarkdown)

  const bounds = sourceSectionBounds(indexMarkdown)
  const trailsHash = hashText(bounds.trailsBlock)
  const trailCount = trailCountFromBlock(bounds.trailsBlock)

  write(`current Memex sources: ${currentSourceAliases.length}`)
  write(`current trails: ${trailCount}`)

  write(`loading ${WIKI_INDEX_ALIAS}…`)
  const wikiIndexMarkdown = await fetchNote(
    WIKI_INDEX_ALIAS,
    token,
    signal
  )
  const wikiIndexHash = hashText(wikiIndexMarkdown)
  const sourceSummaryEntries = parseWikiIndex(wikiIndexMarkdown)
    .filter((entry) => entry.pageType === 'source-summary')

  write(`wiki source-summary entries: ${sourceSummaryEntries.length}`)

  const cleanupManifest = await loadLatestCleanupManifest()
  write(`cleanup manifest: ${cleanupManifest.path}`)

  const candidates = new Map<string, SourceCandidate>()
  let noSourceSummaryCount = 0
  let multiSourceSummaryCount = 0
  let unresolvedFetchedCount = 0

  for (let index = 0; index < sourceSummaryEntries.length; index += 1) {
    const entry = sourceSummaryEntries[index]
    const manifestSource = cleanupManifest.aliasToSource.get(entry.alias)

    let sourceAliases: string[]

    if (manifestSource) {
      sourceAliases = [manifestSource]
    } else {
      const markdown = await fetchNote(entry.alias, token, signal)
      unresolvedFetchedCount += 1
      sourceAliases = sourceAliasesFromMarkdown(markdown)
    }

    if (sourceAliases.length === 0) {
      noSourceSummaryCount += 1
      write(`EXCLUDE NO_SOURCE ${entry.alias}`)
      continue
    }

    if (sourceAliases.length > 1) {
      multiSourceSummaryCount += 1
      write(
        `MULTI_SOURCE ${entry.alias} -> ${sourceAliases.join(',')}`
      )
    }

    for (const sourceAlias of sourceAliases) {
      const normalizedSourceAlias = normalizeAlias(sourceAlias)
      if (!normalizedSourceAlias) continue

      const candidate: SourceCandidate = {
        sourceAlias: normalizedSourceAlias,
        pageAlias: entry.alias,
        title: entry.title,
        summary: entry.description,
        canonical:
          entry.alias ===
          deterministicSourceSummaryAlias(normalizedSourceAlias)
      }

      candidates.set(
        normalizedSourceAlias,
        chooseCandidate(candidates.get(normalizedSourceAlias), candidate)
      )
    }

    if (
      index === 0 ||
      (index + 1) % 50 === 0 ||
      index + 1 === sourceSummaryEntries.length
    ) {
      write(
        `resolved ${index + 1}/${sourceSummaryEntries.length} ` +
        `(HedgeDoc page reads=${unresolvedFetchedCount})`
      )
    }
  }

  const wikiSourceAliases = [...candidates.keys()].sort()
  const currentSet = new Set(currentSourceAliases)
  const wikiSet = new Set(wikiSourceAliases)

  const missing = wikiSourceAliases
    .filter((alias) => !currentSet.has(alias))
    .map((alias) => candidates.get(alias)!)
    .sort((left, right) =>
      left.sourceAlias.localeCompare(right.sourceAlias)
    )

  const preservedExtraAliases = currentSourceAliases
    .filter((alias) => !wikiSet.has(alias))
    .sort()

  const existingBody = bounds.sourceBody.replace(/\s+$/, '')
  const additions = missing.map(renderSourceLine)

  let resultSourceBody = existingBody
  if (additions.length > 0) {
    resultSourceBody +=
      `${resultSourceBody.trim() ? '\n\n' : '\n'}` +
      additions.join('\n')
  }

  const resultMarkdown =
    indexMarkdown.slice(0, bounds.headerEnd) +
    resultSourceBody.replace(/^\n+/, '\n').replace(/\s+$/, '') +
    '\n\n' +
    bounds.trailsBlock

  const resultBounds = sourceSectionBounds(resultMarkdown)

  if (resultBounds.trailsBlock !== bounds.trailsBlock) {
    throw new Error('Internal safety check failed: Trails section changed')
  }

  const resultSourceAliases = sourceAliasesFromIndex(resultMarkdown)

  if (
    resultSourceAliases.length !==
    new Set(resultSourceAliases).size
  ) {
    throw new Error('Internal safety check failed: duplicate source aliases')
  }

  const planHash = hashText(
    JSON.stringify({
      indexHash,
      wikiIndexHash,
      cleanupManifestPath: cleanupManifest.path,
      currentSourceAliases: [...currentSourceAliases].sort(),
      wikiSourceAliases,
      missing: missing.map((item) => ({
        sourceAlias: item.sourceAlias,
        pageAlias: item.pageAlias,
        title: item.title,
        summary: item.summary
      })),
      preservedExtraAliases,
      trailsHash
    })
  )

  return {
    indexMarkdown,
    indexHash,
    wikiIndexMarkdown,
    wikiIndexHash,
    cleanupManifestPath: cleanupManifest.path,
    resultMarkdown,
    currentSourceAliases,
    wikiSourceAliases,
    missing,
    preservedExtraAliases,
    sourceSummaryCount: sourceSummaryEntries.length,
    noSourceSummaryCount,
    multiSourceSummaryCount,
    unresolvedFetchedCount,
    trailCount,
    trailsHash,
    resultSourceCount: resultSourceAliases.length,
    planHash
  }
}

const writePlanReport = (
  plan: RefreshPlan,
  write: ProgressWriter
): void => {
  write('')
  write('=== MEMEX INDEX REFRESH PLAN ===')
  write(`CURRENT_SOURCE_COUNT: ${plan.currentSourceAliases.length}`)
  write(`WIKI_SOURCE_SUMMARY_COUNT: ${plan.sourceSummaryCount}`)
  write(`WIKI_RESOLVED_SOURCE_COUNT: ${plan.wikiSourceAliases.length}`)
  write(`MISSING_SOURCE_COUNT: ${plan.missing.length}`)
  write(
    `PRESERVED_EXTRA_SOURCE_COUNT: ${plan.preservedExtraAliases.length}`
  )
  write(`RESULT_SOURCE_COUNT: ${plan.resultSourceCount}`)
  write(`TRAIL_COUNT: ${plan.trailCount}`)
  write(`TRAILS_PRESERVED: yes`)
  write(`NO_SOURCE_SUMMARY_COUNT: ${plan.noSourceSummaryCount}`)
  write(`MULTI_SOURCE_SUMMARY_COUNT: ${plan.multiSourceSummaryCount}`)
  write(`UNRESOLVED_PAGE_READS: ${plan.unresolvedFetchedCount}`)
  write(`CLEANUP_MANIFEST: ${plan.cleanupManifestPath}`)

  if (plan.missing.length > 0) {
    write('')
    write('=== ADD MISSING SOURCES ===')
    for (const item of plan.missing) {
      write(
        `ADD ${item.sourceAlias} <- ${item.pageAlias} — ` +
        `${cleanInlineText(item.title, item.sourceAlias)}`
      )
    }
  }

  if (plan.preservedExtraAliases.length > 0) {
    write('')
    write('=== PRESERVE EXISTING NON-WIKI SOURCES ===')
    for (const alias of plan.preservedExtraAliases) {
      write(`KEEP ${alias}`)
    }
  }

  write('')
  write(`PREVIEW_HASH: ${plan.planHash}`)
  write('CONFIRMATION_REQUIRED: APPLY')
}

const snapshotPlan = async (
  plan: RefreshPlan,
  timestamp: string
): Promise<string> => {
  const stamp = timestamp
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
    .replace('T', '-')

  const directory = path.join(
    BACKUP_ROOT,
    `memex-index-refresh-${stamp}`
  )

  await mkdir(directory, { recursive: true })

  await writeFile(
    path.join(directory, 'memex-index.md'),
    plan.indexMarkdown,
    'utf8'
  )

  await writeFile(
    path.join(directory, 'memex-wiki-index.md'),
    plan.wikiIndexMarkdown,
    'utf8'
  )

  const manifest = {
    createdAt: timestamp,
    mode: 'pre-apply snapshot',
    indexPath: MEMEX_INDEX_PATH,
    indexHash: plan.indexHash,
    wikiIndexHash: plan.wikiIndexHash,
    cleanupManifestPath: plan.cleanupManifestPath,
    previewHash: plan.planHash,
    currentSourceCount: plan.currentSourceAliases.length,
    wikiResolvedSourceCount: plan.wikiSourceAliases.length,
    missingSourceCount: plan.missing.length,
    resultSourceCount: plan.resultSourceCount,
    trailCount: plan.trailCount,
    trailsHash: plan.trailsHash,
    additions: plan.missing.map((item) => ({
      sourceAlias: item.sourceAlias,
      pageAlias: item.pageAlias,
      title: item.title,
      summary: item.summary
    })),
    preservedExtraAliases: plan.preservedExtraAliases
  }

  await writeFile(
    path.join(directory, 'plan.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  )

  return directory
}

const atomicWriteIndex = async (markdown: string): Promise<void> => {
  const directory = path.dirname(MEMEX_INDEX_PATH)
  const tempPath = path.join(
    directory,
    `.index.md.memex-refresh-${process.pid}-${Date.now()}`
  )

  await writeFile(tempPath, markdown, 'utf8')
  await rename(tempPath, MEMEX_INDEX_PATH)
}

interface RefreshRequest {
  action?: unknown
  previewHash?: unknown
  confirmation?: unknown
}

export async function POST(request: NextRequest) {
  let body: RefreshRequest

  try {
    body = (await request.json()) as RefreshRequest
  } catch {
    return new Response('Invalid JSON\n', { status: 400 })
  }

  const action =
    body.action === 'preview'
      ? 'preview'
      : body.action === 'apply'
        ? 'apply'
        : ''

  if (!action) {
    return new Response('action must be preview or apply\n', {
      status: 400
    })
  }

  const suppliedPreviewHash =
    typeof body.previewHash === 'string'
      ? body.previewHash.trim().toLowerCase()
      : ''

  if (
    action === 'apply' &&
    !/^[0-9a-f]{64}$/.test(suppliedPreviewHash)
  ) {
    return new Response(
      'apply requires the previewHash returned by Preview refresh\n',
      { status: 400 }
    )
  }

  if (action === 'apply' && body.confirmation !== 'APPLY') {
    return new Response(
      'apply requires explicit confirmation value APPLY\n',
      { status: 400 }
    )
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let connected = true

      const write: ProgressWriter = (line = '') => {
        if (!connected) return
        try {
          controller.enqueue(encoder.encode(`${line}\n`))
        } catch {
          connected = false
        }
      }

      try {
        const token = await readMemexApiToken()

        write('=== MEMEX INDEX REFRESH ===')
        write(
          `mode: ${action === 'preview' ? 'PREVIEW / READ ONLY' : 'APPLY'}`
        )
        write(`started: ${new Date().toISOString()}`)
        write('LLM: disabled')
        write('trail mutation: disabled')
        write('')

        const plan = await buildRefreshPlan(
          token,
          action === 'preview' ? request.signal : undefined,
          write
        )

        writePlanReport(plan, write)

        if (action === 'preview') {
          write('')
          write(
            'PREVIEW COMPLETE: memex/index.md and HedgeDoc memex-index were unchanged.'
          )
          return
        }

        if (suppliedPreviewHash !== plan.planHash) {
          throw new Error(
            'STALE PREVIEW: index/wiki state changed; run Preview refresh again'
          )
        }

        if (plan.missing.length === 0) {
          write('')
          write('APPLY COMPLETE: Memex Index already contains all resolved sources.')
          write(`VERIFY_SOURCE_COUNT: ${plan.resultSourceCount}`)
          write(`VERIFY_TRAIL_COUNT: ${plan.trailCount}`)
          return
        }

        const liveBeforeApply = await readFile(MEMEX_INDEX_PATH, 'utf8')
        if (hashText(liveBeforeApply) !== plan.indexHash) {
          throw new Error(
            'STALE PREVIEW: memex/index.md changed immediately before apply'
          )
        }

        const timestamp = new Date().toISOString()

        write('')
        write('=== SNAPSHOT ===')
        const snapshotDirectory = await snapshotPlan(plan, timestamp)
        write(`snapshot: ${snapshotDirectory}`)

        write('')
        write('=== WRITE LOCAL MEMEX INDEX ===')
        await atomicWriteIndex(plan.resultMarkdown)

        const written = await readFile(MEMEX_INDEX_PATH, 'utf8')
        const writtenBounds = sourceSectionBounds(written)

        if (hashText(writtenBounds.trailsBlock) !== plan.trailsHash) {
          await atomicWriteIndex(plan.indexMarkdown)
          throw new Error(
            'Post-write safety check failed: Trails section changed; local index rolled back'
          )
        }

        const writtenSourceCount = sourceAliasesFromIndex(written).length
        if (writtenSourceCount !== plan.resultSourceCount) {
          await atomicWriteIndex(plan.indexMarkdown)
          throw new Error(
            'Post-write safety check failed: source count mismatch; local index rolled back'
          )
        }

        write(
          `LOCAL INDEX UPDATED: ${plan.currentSourceAliases.length} -> ` +
          `${writtenSourceCount} sources`
        )

        write('')
        write('=== SYNC HEDGEDOC MEMEX-INDEX MIRROR ===')
        try {
          await putNote(MEMEX_INDEX_ALIAS, written, token)
        } catch (error) {
          await atomicWriteIndex(plan.indexMarkdown)
          throw new Error(
            `HedgeDoc mirror update failed; local index rolled back: ` +
            `${error instanceof Error ? error.message : String(error)}`
          )
        }

        write('HEDGEDOC MIRROR UPDATED')

        write('')
        write('=== VERIFY ===')
        write(`VERIFY_SOURCE_COUNT: ${writtenSourceCount}`)
        write(`VERIFY_TRAIL_COUNT: ${plan.trailCount}`)
        write('VERIFY_TRAILS_PRESERVED: yes')
        write(`snapshot: ${snapshotDirectory}`)
        write('APPLY COMPLETE')
        write(`finished: ${new Date().toISOString()}`)
      } catch (error) {
        write('')
        write(
          `FATAL: ${error instanceof Error ? error.message : String(error)}`
        )
        write('No LLM action was used.')
      } finally {
        try {
          controller.close()
        } catch {
          // Client disconnected.
        }
      }
    }
  })

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}
