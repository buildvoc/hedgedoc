import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { NextRequest } from 'next/server'

import { readMemexApiToken } from '../memex-revisions/_proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEDGEDOC_NOTES_API =
  process.env.MEMEX_HEDGEDOC_API_BASE ?? 'http://127.0.0.1:3100/api/v2/notes'
const WIKI_INDEX_ALIAS =
  process.env.MEMEX_WIKI_INDEX_ALIAS ?? 'memex-wiki-index'
const BACKUP_ROOT =
  process.env.MEMEX_BACKUP_DIR ?? '/backups/builds'

interface WikiIndexEntry {
  alias: string
  pageType: string
  title: string
  description: string
}

interface SourceSummaryRow {
  entry: WikiIndexEntry
  markdown: string
  markdownHash: string
  sourceAliases: string[]
  rawSourceAlias: string
  expectedAlias: string
  status:
    | 'CANONICAL'
    | 'PLAN'
    | 'REVIEW'
    | 'MULTI_SOURCE'
    | 'NO_SOURCE'
    | 'OWNERSHIP_CONFLICT'
    | 'TARGET_EXISTS'
}

interface CleanupPlan {
  indexMarkdown: string
  indexHash: string
  rows: SourceSummaryRow[]
  safe: SourceSummaryRow[]
  planHash: string
}

type ProgressWriter = (line?: string) => void

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const apiHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`
})

const hashText = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex')

const deterministicSourceSummaryAlias = (sourceAlias: string): string => {
  const candidate = `memex-wiki-source-summary-${sourceAlias}`
  if (candidate.length <= 160) return candidate

  const digest = hashText(sourceAlias).slice(0, 12)
  return `${candidate.slice(0, 147)}-${digest}`
}

const normalizeAlias = (value: string): string => {
  const alias = value.trim()
  return /^[A-Za-z0-9_-]{1,160}$/.test(alias) ? alias : ''
}

const retryableStatus = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status >= 500

const fetchNote = async (
  alias: string,
  token: string,
  signal?: AbortSignal,
  allowMissing = false
): Promise<string | null> => {
  let lastError = ''

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    if (signal?.aborted) throw new Error('Request cancelled')

    try {
      const response = await fetch(
        `${HEDGEDOC_NOTES_API}/${encodeURIComponent(alias)}/content`,
        {
          cache: 'no-store',
          headers: apiHeaders(token),
          signal
        }
      )

      if (allowMissing && response.status === 404) return null
      if (response.ok) return response.text()

      const detail = await response.text()
      lastError =
        `HedgeDoc GET ${alias} failed (${response.status})` +
        (detail ? `: ${detail.slice(0, 200)}` : '')

      if (!retryableStatus(response.status)) break
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error instanceof Error ? error.message : String(error)
    }

    if (attempt < 5) await sleep(attempt * 500)
  }

  throw new Error(lastError || `HedgeDoc GET ${alias} failed`)
}

const createNamedNote = async (
  alias: string,
  markdown: string,
  token: string
): Promise<void> => {
  let lastError = ''

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(
      `${HEDGEDOC_NOTES_API}/${encodeURIComponent(alias)}`,
      {
        method: 'POST',
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
      `HedgeDoc POST ${alias} failed (${response.status})` +
      (detail ? `: ${detail.slice(0, 200)}` : '')

    if (response.status === 409 || !retryableStatus(response.status)) break
    if (attempt < 5) await sleep(attempt * 600)
  }

  throw new Error(lastError || `HedgeDoc POST ${alias} failed`)
}

const putNote = async (
  alias: string,
  markdown: string,
  token: string
): Promise<void> => {
  let lastError = ''

  for (let attempt = 1; attempt <= 5; attempt += 1) {
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
      (detail ? `: ${detail.slice(0, 200)}` : '')

    if (!retryableStatus(response.status)) break
    if (attempt < 5) await sleep(attempt * 600)
  }

  throw new Error(lastError || `HedgeDoc PUT ${alias} failed`)
}

const deleteNote = async (
  alias: string,
  token: string
): Promise<void> => {
  let lastError = ''

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(
      `${HEDGEDOC_NOTES_API}/${encodeURIComponent(alias)}`,
      {
        method: 'DELETE',
        cache: 'no-store',
        headers: {
          ...apiHeaders(token),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ keepMedia: true })
      }
    )

    if (response.status === 404 || response.status === 204 || response.ok) return

    const detail = await response.text()
    lastError =
      `HedgeDoc DELETE ${alias} failed (${response.status})` +
      (detail ? `: ${detail.slice(0, 200)}` : '')

    if (!retryableStatus(response.status)) break
    if (attempt < 5) await sleep(attempt * 600)
  }

  throw new Error(lastError || `HedgeDoc DELETE ${alias} failed`)
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

const assertDerivedWikiPage = (markdown: string, alias: string): void => {
  const frontmatter =
    markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''

  if (!/^\s*-\s+memex-wiki\s*$/m.test(frontmatter)) {
    throw new Error(
      `Refusing to migrate ${alias}: note is not a Memex derived wiki page`
    )
  }
}

const replaceIndexAliases = (
  markdown: string,
  safeRows: SourceSummaryRow[],
  timestamp: string
): string => {
  const mapping = new Map(
    safeRows.map((row) => [row.entry.alias, row.expectedAlias])
  )

  const replaced = markdown
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(
        /^(- \[[^\]]+\]\([^)]*\/n\/)([^/?#)]+)(\) — `[^`]+` — .+)$/
      )
      if (!match) return line

      const oldAlias = normalizeAlias(decodeURIComponent(match[2]))
      const nextAlias = mapping.get(oldAlias)
      return nextAlias ? `${match[1]}${nextAlias}${match[3]}` : line
    })
    .join('\n')

  return replaced.replace(
    /^Updated:\s*.*$/m,
    `Updated: ${timestamp}`
  )
}

const buildCleanupPlan = async (
  token: string,
  signal: AbortSignal | undefined,
  write: ProgressWriter
): Promise<CleanupPlan> => {
  write('loading memex-wiki-index…')
  const indexMarkdown = await fetchNote(
    WIKI_INDEX_ALIAS,
    token,
    signal
  )

  if (indexMarkdown === null) {
    throw new Error(`${WIKI_INDEX_ALIAS} is missing`)
  }

  const entries = parseWikiIndex(indexMarkdown)
    .filter((entry) => entry.pageType === 'source-summary')

  write(`source-summary catalogue entries: ${entries.length}`)
  write('loading source-summary pages…')

  const rows: SourceSummaryRow[] = []

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const markdown = await fetchNote(entry.alias, token, signal)

    if (markdown === null) {
      throw new Error(`Registered derived page is missing: ${entry.alias}`)
    }

    const sourceAliases = sourceAliasesFromMarkdown(markdown)

    let rawSourceAlias = ''
    let expectedAlias = ''
    let status: SourceSummaryRow['status']

    if (sourceAliases.length === 0) {
      status = 'NO_SOURCE'
    } else if (sourceAliases.length > 1) {
      status = 'MULTI_SOURCE'
    } else {
      rawSourceAlias = sourceAliases[0]
      expectedAlias = deterministicSourceSummaryAlias(rawSourceAlias)

      try {
        assertDerivedWikiPage(markdown, entry.alias)
        status = entry.alias === expectedAlias ? 'CANONICAL' : 'PLAN'
      } catch {
        status = 'OWNERSHIP_CONFLICT'
      }
    }

    rows.push({
      entry,
      markdown,
      markdownHash: hashText(markdown),
      sourceAliases,
      rawSourceAlias,
      expectedAlias,
      status
    })

    if (
      index === 0 ||
      (index + 1) % 25 === 0 ||
      index + 1 === entries.length
    ) {
      write(`loaded ${index + 1}/${entries.length}`)
    }

    await sleep(75)
  }

  const sourceCounts = new Map<string, number>()
  for (const row of rows) {
    if (!row.rawSourceAlias) continue
    sourceCounts.set(
      row.rawSourceAlias,
      (sourceCounts.get(row.rawSourceAlias) ?? 0) + 1
    )
  }

  for (const row of rows) {
    if (
      row.status === 'PLAN' &&
      (sourceCounts.get(row.rawSourceAlias) ?? 0) > 1
    ) {
      row.status = 'REVIEW'
    }
  }

  const targetCandidates = rows.filter((row) => row.status === 'PLAN')
  write(`checking ${targetCandidates.length} deterministic target aliases…`)

  for (let index = 0; index < targetCandidates.length; index += 1) {
    const row = targetCandidates[index]
    const existingTarget = await fetchNote(
      row.expectedAlias,
      token,
      signal,
      true
    )

    if (existingTarget !== null) row.status = 'TARGET_EXISTS'

    if (
      index === 0 ||
      (index + 1) % 25 === 0 ||
      index + 1 === targetCandidates.length
    ) {
      write(`target checks ${index + 1}/${targetCandidates.length}`)
    }

    await sleep(75)
  }

  const safe = rows
    .filter((row) => row.status === 'PLAN')
    .sort((left, right) =>
      left.entry.alias.localeCompare(right.entry.alias)
    )

  const indexHash = hashText(indexMarkdown)
  const planHash = hashText(
    JSON.stringify({
      indexHash,
      mappings: safe.map((row) => ({
        from: row.entry.alias,
        to: row.expectedAlias,
        source: row.rawSourceAlias,
        markdownHash: row.markdownHash
      }))
    })
  )

  return {
    indexMarkdown,
    indexHash,
    rows,
    safe,
    planHash
  }
}

const countStatus = (
  rows: SourceSummaryRow[],
  status: SourceSummaryRow['status']
): number => rows.filter((row) => row.status === status).length

const writePlanReport = (
  plan: CleanupPlan,
  write: ProgressWriter
): void => {
  write('')
  write('=== CLASSIFICATION ===')
  write(`safe PLAN: ${countStatus(plan.rows, 'PLAN')}`)
  write(`REVIEW duplicate-source: ${countStatus(plan.rows, 'REVIEW')}`)
  write(`CANONICAL: ${countStatus(plan.rows, 'CANONICAL')}`)
  write(`MULTI_SOURCE: ${countStatus(plan.rows, 'MULTI_SOURCE')}`)
  write(`NO_SOURCE: ${countStatus(plan.rows, 'NO_SOURCE')}`)
  write(
    `OWNERSHIP_CONFLICT: ${countStatus(plan.rows, 'OWNERSHIP_CONFLICT')}`
  )
  write(`TARGET_EXISTS: ${countStatus(plan.rows, 'TARGET_EXISTS')}`)
  write('')

  write('=== SAFE MIGRATION PLAN ===')
  if (plan.safe.length === 0) {
    write('none')
  } else {
    for (const row of plan.safe) {
      write(
        `PLAN ${row.entry.alias} -> ${row.expectedAlias} ` +
        `source=${row.rawSourceAlias}`
      )
    }
  }

  const review = plan.rows.filter((row) => row.status === 'REVIEW')
  if (review.length > 0) {
    write('')
    write('=== EXCLUDED: REVIEW ===')
    for (const row of review) {
      write(
        `REVIEW ${row.entry.alias} -> ${row.expectedAlias} ` +
        `source=${row.rawSourceAlias}`
      )
    }
  }

  const multi = plan.rows.filter((row) => row.status === 'MULTI_SOURCE')
  if (multi.length > 0) {
    write('')
    write('=== EXCLUDED: MULTI_SOURCE ===')
    for (const row of multi) {
      write(`${row.entry.alias} sources=${row.sourceAliases.join(',')}`)
    }
  }

  const noSource = plan.rows.filter((row) => row.status === 'NO_SOURCE')
  if (noSource.length > 0) {
    write('')
    write('=== EXCLUDED: NO_SOURCE ===')
    for (const row of noSource) write(row.entry.alias)
  }

  const ownershipConflicts =
    plan.rows.filter((row) => row.status === 'OWNERSHIP_CONFLICT')
  if (ownershipConflicts.length > 0) {
    write('')
    write('=== EXCLUDED: OWNERSHIP_CONFLICT ===')
    for (const row of ownershipConflicts) {
      write(
        `${row.entry.alias} source=${row.rawSourceAlias} ` +
        `target=${row.expectedAlias}`
      )
    }
  }

  const targetExists =
    plan.rows.filter((row) => row.status === 'TARGET_EXISTS')
  if (targetExists.length > 0) {
    write('')
    write('=== EXCLUDED: TARGET_EXISTS ===')
    for (const row of targetExists) {
      write(`${row.entry.alias} target=${row.expectedAlias}`)
    }
  }

  write('')
  write(`SAFE_PLAN_COUNT: ${plan.safe.length}`)
  write(`PREVIEW_HASH: ${plan.planHash}`)
  write('CONFIRMATION_REQUIRED: APPLY')
}

const snapshotPlan = async (
  plan: CleanupPlan,
  timestamp: string
): Promise<string> => {
  const stamp = timestamp
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
    .replace('T', '-')

  const directory = path.join(
    BACKUP_ROOT,
    `memex-source-summary-cleanup-${stamp}`
  )

  const notesDirectory = path.join(directory, 'legacy-notes')
  await mkdir(notesDirectory, { recursive: true })

  await writeFile(
    path.join(directory, 'memex-wiki-index.md'),
    plan.indexMarkdown,
    'utf8'
  )

  await Promise.all(
    plan.safe.map((row) =>
      writeFile(
        path.join(notesDirectory, `${row.entry.alias}.md`),
        row.markdown,
        'utf8'
      )
    )
  )

  const manifest = {
    createdAt: timestamp,
    mode: 'pre-apply snapshot',
    indexAlias: WIKI_INDEX_ALIAS,
    indexHash: plan.indexHash,
    planHash: plan.planHash,
    safePlanCount: plan.safe.length,
    migrations: plan.safe.map((row) => ({
      oldAlias: row.entry.alias,
      newAlias: row.expectedAlias,
      sourceAlias: row.rawSourceAlias,
      markdownHash: row.markdownHash
    }))
  }

  await writeFile(
    path.join(directory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  )

  return directory
}

interface CleanupRequest {
  action?: unknown
  previewHash?: unknown
  confirmation?: unknown
}

export async function POST(request: NextRequest) {
  let body: CleanupRequest

  try {
    body = (await request.json()) as CleanupRequest
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
    return new Response('action must be preview or apply\n', { status: 400 })
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
      'apply requires the previewHash returned by Preview cleanup\n',
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

        write('=== MEMEX SOURCE-SUMMARY CLEANUP ===')
        write(`mode: ${action === 'preview' ? 'PREVIEW / READ ONLY' : 'APPLY'}`)
        write(`started: ${new Date().toISOString()}`)
        write('LLM: disabled')
        write('')

        const plan = await buildCleanupPlan(
          token,
          action === 'preview' ? request.signal : undefined,
          write
        )

        writePlanReport(plan, write)

        if (action === 'preview') {
          write('')
          write('PREVIEW COMPLETE: no notes or index entries were changed.')
          return
        }

        if (suppliedPreviewHash !== plan.planHash) {
          throw new Error(
            'STALE PREVIEW: live wiki/index state changed; run Preview cleanup again'
          )
        }

        if (plan.safe.length === 0) {
          write('')
          write('APPLY COMPLETE: no safe migrations remain.')
          return
        }

        const timestamp = new Date().toISOString()

        write('')
        write('=== SNAPSHOT ===')
        const snapshotDirectory = await snapshotPlan(plan, timestamp)
        write(`snapshot: ${snapshotDirectory}`)
        write(
          `snapshot files: index + manifest + ${plan.safe.length} legacy notes`
        )

        write('')
        write('=== CREATE DETERMINISTIC TARGETS ===')

        const createdTargets: string[] = []

        try {
          for (let index = 0; index < plan.safe.length; index += 1) {
            const row = plan.safe[index]

            const existingTarget = await fetchNote(
              row.expectedAlias,
              token,
              undefined,
              true
            )

            if (existingTarget !== null) {
              throw new Error(
                `Target appeared during apply: ${row.expectedAlias}`
              )
            }

            await createNamedNote(
              row.expectedAlias,
              row.markdown,
              token
            )
            createdTargets.push(row.expectedAlias)

            write(
              `[${index + 1}/${plan.safe.length}] CREATED ` +
              `${row.expectedAlias}`
            )

            await sleep(100)
          }

          write('')
          write('=== UPDATE WIKI INDEX ===')
          const updatedIndex = replaceIndexAliases(
            plan.indexMarkdown,
            plan.safe,
            timestamp
          )

          await putNote(WIKI_INDEX_ALIAS, updatedIndex, token)
          write(
            `INDEX UPDATED: ${plan.safe.length} aliases migrated`
          )
        } catch (error) {
          write('')
          write('CREATE/INDEX FAILURE: rolling back newly created targets…')

          for (const alias of [...createdTargets].reverse()) {
            try {
              await deleteNote(alias, token)
              write(`ROLLBACK DELETED ${alias}`)
            } catch (rollbackError) {
              write(
                `ROLLBACK WARNING ${alias}: ` +
                `${rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError)}`
              )
            }
          }

          throw error
        }

        write('')
        write('=== DELETE LEGACY ALIASES ===')
        let deleteWarnings = 0

        for (let index = 0; index < plan.safe.length; index += 1) {
          const row = plan.safe[index]

          try {
            await deleteNote(row.entry.alias, token)
            write(
              `[${index + 1}/${plan.safe.length}] DELETED ` +
              `${row.entry.alias}`
            )
          } catch (error) {
            deleteWarnings += 1
            write(
              `[${index + 1}/${plan.safe.length}] ` +
              `ORPHAN_LEGACY_REMAINS ${row.entry.alias}: ` +
              `${error instanceof Error ? error.message : String(error)}`
            )
          }

          await sleep(100)
        }

        write('')
        write('=== APPLY SUMMARY ===')
        write(`migrated: ${plan.safe.length}`)
        write(`legacy delete warnings: ${deleteWarnings}`)
        write(`snapshot: ${snapshotDirectory}`)
        write(
          'REVIEW / MULTI_SOURCE / NO_SOURCE / OWNERSHIP_CONFLICT / ' +
          'TARGET_EXISTS were untouched.'
        )
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
