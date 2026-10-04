import { readFile } from 'node:fs/promises'
import Link from 'next/link'
import { MemexRevisionsButton } from '../../../components/memex-readonly/memex-revisions-button'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const MEMEX_INDEX_PATH = '/data/projects/hedgedoc/memex/index.md'

interface IndexSource {
  alias: string
  title: string
  summary: string
}

interface IndexTrail {
  id: string
  name: string
  reason: string
  members: IndexSource[]
}

const sourcePattern =
  /^- \[([^\]]+)\]\([^)]*\/n\/([^?#)]+)[^)]*\)(?: — (.*))?$/gm

function plainText(value: string) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function anchor(value: string, fallback: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || fallback
}

function parseSources(section: string): IndexSource[] {
  const result: IndexSource[] = []
  const seen = new Set<string>()
  sourcePattern.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = sourcePattern.exec(section)) !== null) {
    const alias = decodeURIComponent(match[2])
    if (seen.has(alias)) continue
    seen.add(alias)
    result.push({
      title: match[1].trim(),
      alias,
      summary: (match[3] ?? '').trim(),
    })
  }

  return result
}

function parseIndex(content: string) {
  const sourceSection =
    content.split('## Sources', 2)[1]?.split('## Trails', 1)[0] ?? ''
  const trailSection = content.split('## Trails', 2)[1] ?? ''

  const sources = parseSources(sourceSection)
  const sourceByAlias = new Map(sources.map((source) => [source.alias, source]))
  const headings = [...trailSection.matchAll(/^###\s+(.+)$/gm)]
  const trails: IndexTrail[] = []

  headings.forEach((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length
    const end = headings[index + 1]?.index ?? trailSection.length
    const block = trailSection.slice(start, end)
    const members = parseSources(block).map(
      (member) => sourceByAlias.get(member.alias) ?? member,
    )

    const reasonLine =
      block
        .split('\n')
        .map((line) => line.trim())
        .find(
          (line) =>
            line &&
            !line.startsWith('-') &&
            !line.startsWith('<!--') &&
            !/^status:/i.test(line),
        ) ?? ''

    const name = heading[1].trim()
    trails.push({
      id: anchor(name, `trail-${index + 1}`),
      name,
      reason: plainText(reasonLine),
      members,
    })
  })

  return { sources, trails }
}

const sectionStyle = {
  border: '1px solid var(--bs-border-color, #dee2e6)',
  borderRadius: '8px',
  marginBottom: '16px',
  padding: '16px',
} as const

export default async function MemexIndexPage() {
  let content = ''
  let errorMessage = ''

  try {
    content = await readFile(MEMEX_INDEX_PATH, 'utf8')
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : 'Unable to read Memex index'
  }

  const { sources, trails } = errorMessage
    ? { sources: [] as IndexSource[], trails: [] as IndexTrail[] }
    : parseIndex(content)

  return (
    <main style={{ margin: '0 auto', maxWidth: '1200px', padding: '24px', width: '100%' }}>
      <header style={{ marginBottom: '20px' }}>
        <h1 style={{ marginBottom: '8px' }}>Memex Index</h1>
        <p style={{ margin: 0 }}>
          Compact read-only view of <code>{MEMEX_INDEX_PATH}</code>
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
          <MemexRevisionsButton noteAlias='memex-index' />
        </nav>
      </header>

      {errorMessage ? (
        <pre
          role='alert'
          style={{
            padding: '16px',
            whiteSpace: 'pre-wrap',
          }}
        >
          {`Unable to read ${MEMEX_INDEX_PATH}\n${errorMessage}`}
        </pre>
      ) : (
        <>
          <section style={sectionStyle}>
            <div
              style={{
                alignItems: 'center',
                display: 'flex',
                flexWrap: 'wrap',
                gap: '8px 18px',
              }}
            >
              <strong>{sources.length} sources</strong>
              <strong>{trails.length} trails</strong>
              <a href='#trails'>Trails</a>
              <a href='#sources'>Sources</a>
            </div>
          </section>

          <section id='trails' style={sectionStyle}>
            <h2 style={{ marginTop: 0 }}>Trails</h2>
            <p style={{ marginTop: '-4px' }}>
              Open a trail to see its reason and members.
            </p>

            <nav
              aria-label='Trail quick navigation'
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px 12px',
                marginBottom: '16px',
              }}
            >
              {trails.map((trail) => (
                <a href={`#${trail.id}`} key={`nav-${trail.id}`}>
                  {trail.name}
                </a>
              ))}
            </nav>

            <div style={{ display: 'grid', gap: '8px' }}>
              {trails.map((trail) => (
                <details
                  id={trail.id}
                  key={trail.id}
                  style={{
                    border: '1px solid var(--bs-border-color, #dee2e6)',
                    borderRadius: '6px',
                    padding: '10px 12px',
                    scrollMarginTop: '12px',
                  }}
                >
                  <summary style={{ cursor: 'pointer' }}>
                    <strong>{trail.name}</strong>{' '}
                    <span style={{ opacity: 0.7 }}>
                      ({trail.members.length} {trail.members.length === 1 ? 'source' : 'sources'})
                    </span>
                  </summary>

                  <div style={{ marginTop: '10px' }}>
                    <p style={{ margin: '0 0 8px' }}>
                      <strong>Reason:</strong>{' '}
                      {trail.reason || 'No reason recorded in index.md.'}
                    </p>

                    {trail.members.length > 0 ? (
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '4px 12px',
                        }}
                      >
                        {trail.members.map((member) => (
                          <Link
                            href={`/n/${encodeURIComponent(member.alias)}`}
                            key={`${trail.id}-${member.alias}`}
                          >
                            {member.title}
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <span style={{ opacity: 0.7 }}>No indexed members.</span>
                    )}
                  </div>
                </details>
              ))}
            </div>
          </section>

          <section id='sources' style={sectionStyle}>
            <details>
              <summary style={{ cursor: 'pointer' }}>
                <strong>Sources ({sources.length})</strong> — expand catalogue
              </summary>

              <div style={{ display: 'grid', gap: '8px', marginTop: '12px' }}>
                {sources.map((source) => (
                  <div
                    key={source.alias}
                    style={{
                      borderBottom: '1px solid var(--bs-border-color, #dee2e6)',
                      paddingBottom: '8px',
                    }}
                  >
                    <Link href={`/n/${encodeURIComponent(source.alias)}`}>
                      <strong>{source.title}</strong>
                    </Link>
                    {source.summary ? (
                      <span> — {source.summary}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            </details>
          </section>
        </>
      )}
    </main>
  )
}
