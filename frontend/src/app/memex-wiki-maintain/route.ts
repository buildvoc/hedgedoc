import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { readMemexApiToken } from '../memex-revisions/_proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEDGEDOC_NOTES_API =
  process.env.MEMEX_HEDGEDOC_API_BASE ?? 'http://127.0.0.1:3100/api/v2/notes'
const HEDGEDOC_PUBLIC_BASE =
  process.env.MEMEX_HEDGEDOC_PUBLIC_BASE_URL ?? 'http://192.168.1.142:8180'
const WIKI_INDEX_ALIAS = process.env.MEMEX_WIKI_INDEX_ALIAS ?? 'memex-wiki-index'

const PAGE_TYPES = new Set([
  'source-summary',
  'entity',
  'topic',
  'comparison',
  'synthesis',
])

interface WikiIndexEntry {
  alias: string
  pageType: string
  title: string
  description: string
}

interface WikiPageMutation {
  alias?: unknown
  pageType?: unknown
  title?: unknown
  description?: unknown
  tags?: unknown
  sourceAliases?: unknown
  body?: unknown
  expectedCurrentHash?: unknown
  expectMissing?: unknown
}

interface WikiMutationRequest {
  dryRun?: unknown
  provenance?: unknown
  pages?: unknown
}

const yamlQuote = (value: string): string =>
  JSON.stringify(value.replace(/\r?\n/g, ' ').trim())

const normalizeAlias = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  const alias = value.trim()
  return /^[A-Za-z0-9_-]{1,160}$/.test(alias) ? alias : ''
}

const markdownHash = (markdown: string): string =>
  createHash('sha256').update(markdown.trim(), 'utf8').digest('hex')

const normalizeExpectedHash = (value: unknown): string => {
  if (value === undefined) return ''
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value.trim())) {
    throw new Error('expectedCurrentHash must be a SHA-256 hex digest')
  }
  return value.trim().toLowerCase()
}

const slugifyWikiTitle = (value: string): string => {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
  return slug || 'page'
}

const derivedAlias = (pageType: string, title: string): string =>
  `memex-wiki-${pageType}-${slugifyWikiTitle(title)}`.slice(0, 160)

const cleanText = (
  value: unknown,
  field: string,
  maximum: number,
  required = true,
): string => {
  if (typeof value !== 'string') {
    if (!required) return ''
    throw new Error(`${field} is required`)
  }

  const text = value.trim()
  if (!text && required) throw new Error(`${field} is required`)
  if (text.length > maximum) {
    throw new Error(`${field} must be ${maximum} characters or fewer`)
  }
  return text
}

const normalizePageType = (value: unknown): string => {
  const pageType = cleanText(value, 'pageType', 40)
  if (!PAGE_TYPES.has(pageType)) {
    throw new Error(`Unsupported pageType: ${pageType}`)
  }
  return pageType
}

const normalizeTags = (value: unknown, pageType: string): string[] => {
  const requested = Array.isArray(value)
    ? value
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(tag))
    : []

  return [...new Set(['memex-wiki', `memex-${pageType}`, ...requested])].slice(0, 20)
}

const normalizeSourceAliases = (value: unknown): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('sourceAliases must be an array')

  const aliases = value.map((alias) => normalizeAlias(alias))
  if (aliases.some((alias) => !alias)) {
    throw new Error('sourceAliases contains an invalid HedgeDoc alias')
  }
  const derivedAliases = aliases.filter((alias) => alias.startsWith('memex-wiki-'))
  if (derivedAliases.length > 0) {
    throw new Error(
      `sourceAliases must reference raw HedgeDoc evidence, not derived wiki pages: ${derivedAliases.join(', ')}`,
    )
  }

  return [...new Set(aliases)].slice(0, 100)
}

const normalizeBody = (value: unknown, title: string): string => {
  const body = cleanText(value, 'body', 60000)
  if (body.startsWith('---\n') || body.startsWith('---\r\n')) {
    throw new Error('body must not include YAML frontmatter')
  }

  return /^#\s+/m.test(body) ? body : `# ${title}\n\n${body}`
}

const apiHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
})

const fetchNote = async (
  alias: string,
  token: string,
  allowMissing = false,
): Promise<string | null> => {
  const response = await fetch(
    `${HEDGEDOC_NOTES_API}/${encodeURIComponent(alias)}/content`,
    {
      cache: 'no-store',
      headers: apiHeaders(token),
    },
  )

  if (allowMissing && response.status === 404) return null
  if (!response.ok) {
    throw new Error(`HedgeDoc GET ${alias} failed (${response.status})`)
  }
  return response.text()
}

const putNote = async (
  alias: string,
  markdown: string,
  token: string,
): Promise<void> => {
  const response = await fetch(
    `${HEDGEDOC_NOTES_API}/${encodeURIComponent(alias)}`,
    {
      method: 'PUT',
      cache: 'no-store',
      headers: {
        ...apiHeaders(token),
        'Content-Type': 'text/markdown',
      },
      body: markdown,
    },
  )

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(
      `HedgeDoc PUT ${alias} failed (${response.status})` +
        (detail ? `: ${detail.slice(0, 200)}` : ''),
    )
  }
}

const createNamedNote = async (
  alias: string,
  markdown: string,
  token: string,
): Promise<void> => {
  const response = await fetch(
    `${HEDGEDOC_NOTES_API}/${encodeURIComponent(alias)}`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: {
        ...apiHeaders(token),
        'Content-Type': 'text/markdown',
      },
      body: markdown,
    },
  )

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(
      `HedgeDoc POST ${alias} failed (${response.status})` +
        (detail ? `: ${detail.slice(0, 200)}` : ''),
    )
  }

  const note = (await response.json()) as {
    metadata?: { primaryAlias?: unknown }
  }
  const createdAlias = normalizeAlias(note.metadata?.primaryAlias)
  if (createdAlias !== alias) {
    throw new Error(
      `Created named HedgeDoc returned unexpected alias: ${createdAlias || 'missing'}`,
    )
  }
}

const parseWikiIndex = (markdown: string | null): WikiIndexEntry[] => {
  if (!markdown) return []
  const entries: WikiIndexEntry[] = []

  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(
      /^- \[([^\]]+)\]\([^)]*\/n\/([^/?#)]+)\) — `([^`]+)` — (.+)$/,
    )
    if (!match) continue

    const alias = normalizeAlias(decodeURIComponent(match[2]))
    if (!alias) continue
    entries.push({
      title: match[1].trim(),
      alias,
      pageType: match[3].trim(),
      description: match[4].trim(),
    })
  }

  return entries
}

const markdownLinkTitle = (value: string): string =>
  value.replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim()

const buildWikiIndex = (
  entries: WikiIndexEntry[],
  updatedAt: string,
): string => {
  const sorted = [...entries].sort((left, right) =>
    left.pageType.localeCompare(right.pageType) || left.title.localeCompare(right.title)
  )

  const rows = sorted.length
    ? sorted
        .map(
          (entry) =>
            `- [${markdownLinkTitle(entry.title)}](${HEDGEDOC_PUBLIC_BASE}/n/${entry.alias}) — \`${entry.pageType}\` — ${entry.description.replace(/\r?\n/g, ' ')}`,
        )
        .join('\n')
    : 'No derived wiki pages yet.'

  return `---\ntype: document\nokf_type: Concept\ntitle: "Memex Wiki Index"\ndescription: "LLM-maintained catalogue of derived Memex wiki pages."\ntags:\n  - memex\n  - memex-wiki\n  - index\nstatus: workarea\nsources: []\n---\n\n# Memex Wiki Index\n\nUpdated: ${updatedAt}\n\nThe pages below are derived knowledge artifacts. Raw HedgeDoc sources remain canonical evidence.\n\n## Pages\n\n${rows}\n`
}

const buildDerivedPage = (
  pageType: string,
  title: string,
  description: string,
  tags: string[],
  sourceAliases: string[],
  body: string,
  provenance: string,
  updatedAt: string,
): string => {
  const sourceBlock = sourceAliases.length
    ? `sources:\n${sourceAliases
        .map((alias) => `  - ${yamlQuote(`${HEDGEDOC_PUBLIC_BASE}/n/${alias}`)}`)
        .join('\n')}`
    : 'sources: []'
  const tagLines = tags.map((tag) => `  - ${tag}`).join('\n')

  return `---\ntype: document\nokf_type: Concept\ntitle: ${yamlQuote(title)}\ndescription: ${yamlQuote(description)}\ntags:\n${tagLines}\nstatus: workarea\n${sourceBlock}\nmemex_page_type: ${yamlQuote(pageType)}\nmemex_updated_at: ${yamlQuote(updatedAt)}\nmemex_change_provenance: ${yamlQuote(provenance)}\n---\n\n${body.trim()}\n`
}

const assertDerivedWikiPage = (markdown: string, alias: string): void => {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
  if (!/^\s*-\s+memex-wiki\s*$/m.test(frontmatter)) {
    throw new Error(`Refusing to update ${alias}: note is not a Memex derived wiki page`)
  }
}

export async function GET(request: NextRequest) {
  try {
    const token = await readMemexApiToken()
    const index = await fetchNote(WIKI_INDEX_ALIAS, token, true)
    const pages = parseWikiIndex(index)
    const requestedAlias = normalizeAlias(request.nextUrl.searchParams.get('alias'))

    if (request.nextUrl.searchParams.has('alias')) {
      if (!requestedAlias) {
        return NextResponse.json({ error: 'Invalid alias' }, { status: 400 })
      }
      if (!pages.some((page) => page.alias === requestedAlias)) {
        return NextResponse.json(
          { error: 'Alias is not a registered Memex derived wiki page' },
          { status: 404 },
        )
      }
      const markdown = await fetchNote(requestedAlias, token)
      if (markdown === null) throw new Error(`Derived wiki page ${requestedAlias} is missing`)
      assertDerivedWikiPage(markdown, requestedAlias)
      return NextResponse.json(
        { alias: requestedAlias, markdown },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }

    return NextResponse.json(
      { indexAlias: WIKI_INDEX_ALIAS, count: pages.length, pages },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Memex wiki lookup failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as WikiMutationRequest
    const dryRun = body.dryRun === true
    const provenance = cleanText(
      body.provenance ?? 'conversation',
      'provenance',
      240,
    )

    if (!Array.isArray(body.pages) || body.pages.length === 0) {
      return NextResponse.json({ error: 'pages must be a non-empty array' }, { status: 400 })
    }
    if (body.pages.length > 12) {
      return NextResponse.json({ error: 'A mutation may change at most 12 wiki pages' }, { status: 400 })
    }

    const token = await readMemexApiToken()
    const currentIndex = await fetchNote(WIKI_INDEX_ALIAS, token, true)
    const registry = parseWikiIndex(currentIndex)
    const registeredAliases = new Set(registry.map((entry) => entry.alias))
    const requestTimestamp = new Date().toISOString()

    const normalized = (body.pages as WikiPageMutation[]).map((page) => {
      const requestedAlias = normalizeAlias(page.alias)
      if (page.alias !== undefined && !requestedAlias) {
        throw new Error('Invalid page alias')
      }

      const pageType = normalizePageType(page.pageType)
      const title = cleanText(page.title, 'title', 160)
      const registeredMatch = registry.find(
        (entry) =>
          entry.pageType === pageType &&
          entry.title.localeCompare(title, undefined, { sensitivity: 'base' }) === 0,
      )
      const alias = requestedAlias || registeredMatch?.alias || derivedAlias(pageType, title)
      const explicitAlias = Boolean(requestedAlias)
      if (explicitAlias && !registeredAliases.has(alias)) {
        throw new Error(
          `Refusing to update ${alias}: it is not registered in ${WIKI_INDEX_ALIAS}`,
        )
      }

      const description = cleanText(page.description, 'description', 500)
      const tags = normalizeTags(page.tags, pageType)
      const sourceAliases = normalizeSourceAliases(page.sourceAliases)
      const markdown = buildDerivedPage(
        pageType,
        title,
        description,
        tags,
        sourceAliases,
        normalizeBody(page.body, title),
        provenance,
        requestTimestamp,
      )

      return {
        alias,
        pageType,
        title,
        description,
        sourceAliases,
        markdown,
      }
    })

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        provenance,
        count: normalized.length,
        pages: normalized,
      })
    }

    const updatedAt = requestTimestamp
    const committed: Array<WikiIndexEntry & { created: boolean }> = []

    if (currentIndex === null) {
      await createNamedNote(
        WIKI_INDEX_ALIAS,
        buildWikiIndex(registry, updatedAt),
        token,
      )
    }

    for (const page of normalized) {
      const alias = page.alias
      let created = false
      const existing = await fetchNote(alias, token, true)

      if (existing !== null) {
        assertDerivedWikiPage(existing, alias)
        await putNote(alias, page.markdown, token)
      } else {
        await createNamedNote(alias, page.markdown, token)
        created = true
      }

      committed.push({
        alias,
        pageType: page.pageType,
        title: page.title,
        description: page.description,
        created,
      })
    }

    const byAlias = new Map(registry.map((entry) => [entry.alias, entry]))
    for (const page of committed) {
      byAlias.set(page.alias, {
        alias: page.alias,
        pageType: page.pageType,
        title: page.title,
        description: page.description,
      })
    }

    await putNote(
      WIKI_INDEX_ALIAS,
      buildWikiIndex([...byAlias.values()], updatedAt),
      token,
    )

    return NextResponse.json({
      committed: true,
      provenance,
      updatedAt,
      indexAlias: WIKI_INDEX_ALIAS,
      count: committed.length,
      pages: committed,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Memex wiki mutation failed'
    const status = message.startsWith('Stale preview:') ? 409 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
