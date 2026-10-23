import { createHash } from 'node:crypto'

import { readMemexApiToken } from '../memex-revisions/_proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEDGEDOC_NOTES_API =
  process.env.MEMEX_HEDGEDOC_API_BASE ?? 'http://127.0.0.1:3100/api/v2/notes'
const WIKI_INDEX_ALIAS =
  process.env.MEMEX_WIKI_INDEX_ALIAS ?? 'memex-wiki-index'

interface WikiIndexEntry {
  alias: string
  pageType: string
  title: string
  description: string
}

type AuditStatus =
  | 'CANONICAL'
  | 'LEGACY_ALIAS'
  | 'NO_SOURCE'
  | 'MULTI_SOURCE'
  | 'PERSISTENT_ERROR'

interface AuditRow {
  alias: string
  title: string
  rawSourceAlias: string
  expectedAlias: string
  status: AuditStatus
  sourceAliases: string[]
  error?: string
}

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const apiHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`
})

const fetchNote = async (
  alias: string,
  token: string,
  signal: AbortSignal,
  allowMissing = false
): Promise<string | null> => {
  let lastError = ''

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    if (signal.aborted) throw new Error('Audit cancelled')

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
    } catch (error) {
      if (signal.aborted) throw error
      lastError = error instanceof Error ? error.message : String(error)
    }

    if (attempt < 5) await sleep(attempt * 750)
  }

  throw new Error(lastError || `HedgeDoc GET ${alias} failed`)
}

const parseWikiIndex = (markdown: string | null): WikiIndexEntry[] => {
  if (!markdown) return []

  const entries: WikiIndexEntry[] = []

  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(
      /^- \[([^\]]+)\]\([^)]*\/n\/([^/?#)]+)\) — `([^`]+)` — (.+)$/
    )
    if (!match) continue

    entries.push({
      title: match[1].trim(),
      alias: decodeURIComponent(match[2]).trim(),
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

  const aliases = Array.from(
    sourceBlock.matchAll(/\/(?:n|p|s)\/([A-Za-z0-9_-]+)/g),
    (match) => match[1]
  )

  return [...new Set(aliases)]
}

const deterministicSourceSummaryAlias = (sourceAlias: string): string => {
  const candidate = `memex-wiki-source-summary-${sourceAlias}`

  if (candidate.length <= 160) return candidate

  const digest = createHash('sha256')
    .update(sourceAlias, 'utf8')
    .digest('hex')
    .slice(0, 12)

  return `${candidate.slice(0, 147)}-${digest}`
}

export async function GET(request: Request) {
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (value = '') => {
        if (request.signal.aborted) return
        controller.enqueue(encoder.encode(`${value}\n`))
      }

      try {
        write('=== MEMEX SOURCE-SUMMARY IDENTITY AUDIT ===')
        write('mode: READ ONLY')
        write(`started: ${new Date().toISOString()}`)
        write('')

        const token = await readMemexApiToken()
        const index = await fetchNote(
          WIKI_INDEX_ALIAS,
          token,
          request.signal
        )

        const pages = parseWikiIndex(index)
          .filter((page) => page.pageType === 'source-summary')

        write(`source-summary catalogue entries: ${pages.length}`)
        write('')

        const rows: AuditRow[] = []

        for (let index = 0; index < pages.length; index += 1) {
          if (request.signal.aborted) throw new Error('Audit cancelled')

          const page = pages[index]
          let row: AuditRow

          try {
            const markdown = await fetchNote(
              page.alias,
              token,
              request.signal
            )

            if (markdown === null) {
              throw new Error('Derived wiki page is missing')
            }

            const sourceAliases = sourceAliasesFromMarkdown(markdown)

            if (sourceAliases.length === 0) {
              row = {
                alias: page.alias,
                title: page.title,
                rawSourceAlias: '',
                expectedAlias: '',
                sourceAliases,
                status: 'NO_SOURCE'
              }
            } else if (sourceAliases.length > 1) {
              row = {
                alias: page.alias,
                title: page.title,
                rawSourceAlias: '',
                expectedAlias: '',
                sourceAliases,
                status: 'MULTI_SOURCE'
              }
            } else {
              const rawSourceAlias = sourceAliases[0]
              const expectedAlias =
                deterministicSourceSummaryAlias(rawSourceAlias)

              row = {
                alias: page.alias,
                title: page.title,
                rawSourceAlias,
                expectedAlias,
                sourceAliases,
                status:
                  page.alias === expectedAlias
                    ? 'CANONICAL'
                    : 'LEGACY_ALIAS'
              }
            }
          } catch (error) {
            if (request.signal.aborted) throw error

            row = {
              alias: page.alias,
              title: page.title,
              rawSourceAlias: '',
              expectedAlias: '',
              sourceAliases: [],
              status: 'PERSISTENT_ERROR',
              error: error instanceof Error ? error.message : String(error)
            }
          }

          rows.push(row)

          write(
            `[${String(index + 1).padStart(String(pages.length).length, ' ')}/${pages.length}] ` +
            `${row.status.padEnd(16)} ${row.alias}`
          )

          await sleep(100)
          if ((index + 1) % 50 === 0) await sleep(500)
        }

        const sourceCounts = new Map<string, number>()

        for (const row of rows) {
          if (!row.rawSourceAlias) continue
          sourceCounts.set(
            row.rawSourceAlias,
            (sourceCounts.get(row.rawSourceAlias) ?? 0) + 1
          )
        }

        const canonical = rows.filter((row) => row.status === 'CANONICAL')
        const legacy = rows.filter((row) => row.status === 'LEGACY_ALIAS')
        const noSource = rows.filter((row) => row.status === 'NO_SOURCE')
        const multiSource = rows.filter((row) => row.status === 'MULTI_SOURCE')
        const errors = rows.filter((row) => row.status === 'PERSISTENT_ERROR')
        const duplicatePages = rows.filter(
          (row) =>
            row.rawSourceAlias &&
            (sourceCounts.get(row.rawSourceAlias) ?? 0) > 1
        )

        const duplicateSources = Array.from(sourceCounts.entries())
          .filter(([, count]) => count > 1)
          .map(([alias]) => alias)
          .sort()

        write('')
        write('=== SUMMARY ===')
        write(`source summaries: ${rows.length}`)
        write(`canonical: ${canonical.length}`)
        write(`legacy aliases: ${legacy.length}`)
        write(`duplicate-source pages: ${duplicatePages.length}`)
        write(`duplicate source groups: ${duplicateSources.length}`)
        write(`no source: ${noSource.length}`)
        write(`multi source: ${multiSource.length}`)
        write(`persistent errors: ${errors.length}`)

        write('')
        write('=== DUPLICATE / COLLISION GROUPS ===')

        if (duplicateSources.length === 0) {
          write('none')
        } else {
          for (const rawSourceAlias of duplicateSources) {
            const members = rows.filter(
              (row) => row.rawSourceAlias === rawSourceAlias
            )
            const expected =
              deterministicSourceSummaryAlias(rawSourceAlias)

            write('')
            write(`SOURCE ${rawSourceAlias}`)
            write(`TARGET ${expected}`)

            for (const member of members) {
              write(`  ${member.status} ${member.alias}`)
            }
          }
        }

        write('')
        write('=== LEGACY -> DETERMINISTIC CLEANUP PLAN ===')

        if (legacy.length === 0) {
          write('none')
        } else {
          for (
            const row of [...legacy].sort((left, right) =>
              left.alias.localeCompare(right.alias)
            )
          ) {
            const duplicate =
              (sourceCounts.get(row.rawSourceAlias) ?? 0) > 1

            write(
              `${duplicate ? 'REVIEW' : 'PLAN  '} ` +
              `${row.alias} -> ${row.expectedAlias} ` +
              `source=${row.rawSourceAlias}`
            )
          }
        }

        if (multiSource.length > 0) {
          write('')
          write('=== MULTI-SOURCE CORRUPTION ===')
          for (const row of multiSource) {
            write(`${row.alias} sources=${row.sourceAliases.join(',')}`)
          }
        }

        if (noSource.length > 0) {
          write('')
          write('=== SOURCELESS PAGES ===')
          for (const row of noSource) write(row.alias)
        }

        if (errors.length > 0) {
          write('')
          write('=== PERSISTENT FETCH ERRORS ===')
          for (const row of errors) {
            write(`${row.alias}: ${row.error ?? 'unknown error'}`)
          }
        }

        write('')
        write('READ-ONLY COMPLETE: no notes or index entries were changed.')
        write(`finished: ${new Date().toISOString()}`)
      } catch (error) {
        if (!request.signal.aborted) {
          write('')
          write(
            `FATAL: ${error instanceof Error ? error.message : String(error)}`
          )
        }
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
