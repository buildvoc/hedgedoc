import { readFile } from 'node:fs/promises'
import Link from 'next/link'
import { MemexReadOnlyMarkdown } from '../../../components/memex-readonly/memex-readonly-markdown'
import { MemexRevisionsButton } from '../../../components/memex-readonly/memex-revisions-button'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const MEMEX_LOG_PATH = '/data/projects/hedgedoc/memex/log.md'
const MEMEX_INDEX_PATH = '/data/projects/hedgedoc/memex/index.md'
const LOG_ENTRY_HEADING = /^## \[([^\]]+)\].*$/m

const INDEX_SOURCE_LINK =
  /^- \[([^\]]+)\]\([^)\n]*\/n\/([^)#?\s]+)\)(?:\s+—.*)?$/gm
const LOG_SOURCE_HEADING =
  /^(## \[[^\]]+\]\s+(?:ingest|revision check)\s+\|\s+)([^\n]+)$/gm

function readableAlias(alias: string): string {
  return alias
    .replace(/^docling-/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function displayLogSourceTitles(content: string, indexContent: string): string {
  const titles = new Map<string, string>()

  for (const match of indexContent.matchAll(INDEX_SOURCE_LINK)) {
    titles.set(match[2], match[1])
  }

  return content.replace(
    LOG_SOURCE_HEADING,
    (_heading, prefix: string, rawAlias: string) => {
      const alias = rawAlias.trim()
      return `${prefix}${titles.get(alias) ?? readableAlias(alias)}`
    },
  )
}

function newestLogEntriesFirst(content: string): string {
  const matches = Array.from(content.matchAll(/^## \[[^\]]+\].*$/gm))
  if (matches.length < 2) {
    return content
  }

  const firstEntryOffset = matches[0].index ?? 0
  const prefix = content.slice(0, firstEntryOffset).trimEnd()
  const entries = matches.map((match, index) => {
    const start = match.index ?? 0
    const end =
      index + 1 < matches.length ? (matches[index + 1].index ?? content.length) : content.length
    const block = content.slice(start, end).trimEnd()
    const heading = block.match(LOG_ENTRY_HEADING)
    const timestamp = heading ? Date.parse(heading[1]) : Number.NaN

    return {
      block,
      originalIndex: index,
      timestamp: Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp,
    }
  })

  entries.sort((a, b) => {
    if (a.timestamp === b.timestamp) {
      return a.originalIndex - b.originalIndex
    }
    return b.timestamp - a.timestamp
  })

  return `${prefix}${prefix ? '\n\n' : ''}${entries.map(({ block }) => block).join('\n\n')}\n`
}

export default async function MemexLogPage() {
  let content = ''
  let errorMessage = ''

  try {
    const [logContent, indexContent] = await Promise.all([
      readFile(MEMEX_LOG_PATH, 'utf8'),
      readFile(MEMEX_INDEX_PATH, 'utf8'),
    ])
    content = displayLogSourceTitles(
      newestLogEntriesFirst(logContent),
      indexContent,
    )
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : 'Unable to read Memex log'
  }

  return (
    <main style={{ width: '100%' }}>
      <header
        style={{
          margin: '0 auto',
          maxWidth: '1200px',
          padding: '24px 24px 12px',
          width: '100%',
        }}
      >
        <h1 style={{ marginBottom: '8px' }}>Memex Log</h1>
        <p style={{ margin: 0 }}>
          Read-only live view of <code>{MEMEX_LOG_PATH}</code>, newest entries first
        </p>
        <nav
          aria-label='Memex read-only files'
          style={{
            alignItems: 'center',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '12px',
            marginTop: '16px',
          }}
        >
          <Link href='/memex-index'>Index</Link>
          <Link href='/memex-log'>Log</Link>
          <Link href='/explore/my?memex=pending'>Process Pending</Link>
          <MemexRevisionsButton noteAlias='memex-log' />
        </nav>
      </header>

      {errorMessage ? (
        <pre
          role='alert'
          style={{
            margin: '12px auto 24px',
            maxWidth: '1200px',
            padding: '16px 24px',
            whiteSpace: 'pre-wrap',
          }}
        >
          {`Unable to read ${MEMEX_LOG_PATH}\n${errorMessage}`}
        </pre>
      ) : (
        <MemexReadOnlyMarkdown content={content} />
      )}
    </main>
  )
}
