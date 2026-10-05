import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEDGEDOC_API_BASE_URL = (
  process.env.MEMEX_HEDGEDOC_API_BASE_URL ?? 'http://127.0.0.1:3100/api/v2'
).replace(/\/+$/, '')
const FOCUS_PATH =
  process.env.MEMEX_WIKI_GRAPH_FOCUS_PATH ??
  '/data/projects/hedgedoc/memex/wiki_graph_focus.json'
const WIKI_INDEX_ALIAS = 'memex-wiki-index'

type WikiPageRef = {
  alias?: string
  pageType?: string
  title?: string
}

type ResolvedFocus = {
  version: 1
  updatedAt: string
  mode: 'none' | 'topic' | 'entity-topic'
  topicAliases: string[]
  entityAliases: string[]
  sourceAliases: string[]
}

type WikiPage = {
  alias: string
  title: string
  content: string
  sources: string[]
}

const unique = <T,>(values: T[]): T[] => [...new Set(values)]

const cleanYamlScalar = (value: string): string =>
  value.trim().replace(/^["']|["']$/g, '').trim()

const parseFrontmatter = (content: string): string[] => {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return []

  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  return end > 0 ? lines.slice(1, end) : []
}

const extractTitle = (content: string): string => {
  for (const line of parseFrontmatter(content)) {
    const match = line.match(/^title:\s*(.+)$/)
    if (match?.[1]) return cleanYamlScalar(match[1])
  }
  return ''
}

const sourceAliasFromValue = (value: string): string | null => {
  const cleaned = cleanYamlScalar(value)
  const urlMatch = cleaned.match(/\/(?:n|s)\/([A-Za-z0-9_-]+)/)
  if (urlMatch?.[1]) return decodeURIComponent(urlMatch[1])

  if (/^[A-Za-z0-9_-]+$/.test(cleaned) && !cleaned.startsWith('memex-wiki-')) {
    return cleaned
  }

  return null
}

const extractSources = (content: string): string[] => {
  const lines = parseFrontmatter(content)
  const aliases: string[] = []
  let readingSources = false

  for (const line of lines) {
    const sourcesMatch = line.match(/^sources:\s*(.*)$/)

    if (sourcesMatch) {
      readingSources = true
      const inline = sourcesMatch[1].trim()

      if (inline) {
        for (const match of inline.matchAll(/\/(?:n|s)\/([A-Za-z0-9_-]+)/g)) {
          if (match[1]) aliases.push(decodeURIComponent(match[1]))
        }
      }
      continue
    }

    if (!readingSources) continue

    const item = line.match(/^\s*-\s*(.+)$/)
    if (item?.[1]) {
      const alias = sourceAliasFromValue(item[1])
      if (alias) aliases.push(alias)
      continue
    }

    if (/^\S/.test(line)) break
  }

  return unique(aliases.filter((alias) => !alias.startsWith('memex-wiki-')))
}

const apiHeaders = (): HeadersInit => {
  const token = process.env.MEMEX_API_TOKEN
  return token ? { Authorization: `Bearer ${token}` } : {}
}

const readWikiPage = async (alias: string): Promise<WikiPage> => {
  const response = await fetch(
    `${HEDGEDOC_API_BASE_URL}/notes/${encodeURIComponent(alias)}/content`,
    {
      cache: 'no-store',
      headers: apiHeaders(),
    },
  )

  if (!response.ok) {
    throw new Error(`HedgeDoc ${alias} HTTP ${response.status}`)
  }

  const content = await response.text()
  return {
    alias,
    title: extractTitle(content),
    content,
    sources: extractSources(content),
  }
}

const topicAliasesFromIndex = async (): Promise<string[]> => {
  const index = await readWikiPage(WIKI_INDEX_ALIAS)
  return unique(index.content.match(/\bmemex-wiki-topic-[a-z0-9-]+\b/gi) ?? [])
}

const resolveTopic = async (
  topicAliases: string[],
  entityAliases: string[],
): Promise<ResolvedFocus> => {
  const topics = await Promise.all(topicAliases.map(readWikiPage))
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    mode: 'topic',
    topicAliases: topics.map((page) => page.alias),
    entityAliases,
    sourceAliases: unique(topics.flatMap((page) => page.sources)),
  }
}

const resolveEntityViaTopic = async (
  entityAliases: string[],
): Promise<ResolvedFocus> => {
  const entities = await Promise.all(entityAliases.map(readWikiPage))
  const entitySources = new Set(entities.flatMap((page) => page.sources))
  const entityNeedles = entities
    .flatMap((page) => [page.alias, page.title])
    .map((value) => value.trim().toLocaleLowerCase())
    .filter(Boolean)

  const topicAliases = await topicAliasesFromIndex()
  const topics = (
    await Promise.all(
      topicAliases.map(async (alias) => {
        try {
          return await readWikiPage(alias)
        } catch {
          return null
        }
      }),
    )
  ).filter((page): page is WikiPage => page !== null)

  const candidates = topics
    .map((page) => {
      const overlap = page.sources.filter((alias) => entitySources.has(alias)).length
      const body = page.content.toLocaleLowerCase()
      const mentionsEntity = entityNeedles.some((needle) => body.includes(needle))
      return { page, overlap, mentionsEntity }
    })
    .filter((item) => item.overlap > 0 || item.mentionsEntity)
    .sort((a, b) => {
      if (a.overlap !== b.overlap) return b.overlap - a.overlap
      if (a.mentionsEntity !== b.mentionsEntity) return a.mentionsEntity ? -1 : 1
      return a.page.alias.localeCompare(b.page.alias)
    })

  if (candidates.length === 0) {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      mode: 'none',
      topicAliases: [],
      entityAliases,
      sourceAliases: [],
    }
  }

  const bestOverlap = Math.max(...candidates.map((item) => item.overlap))
  const selected =
    bestOverlap > 0
      ? candidates.filter((item) => item.overlap === bestOverlap)
      : candidates.filter((item) => item.mentionsEntity)

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    mode: 'entity-topic',
    topicAliases: selected.map((item) => item.page.alias),
    entityAliases,
    sourceAliases: unique(selected.flatMap((item) => item.page.sources)),
  }
}

const resolveFocus = async (pages: WikiPageRef[]): Promise<ResolvedFocus> => {
  const topicAliases = unique(
    pages
      .filter((page) => page.pageType === 'topic')
      .map((page) => page.alias?.trim() ?? '')
      .filter((alias): alias is string => alias.startsWith('memex-wiki-topic-')),
  )
  const entityAliases = unique(
    pages
      .filter((page) => page.pageType === 'entity')
      .map((page) => page.alias?.trim() ?? '')
      .filter((alias): alias is string => alias.startsWith('memex-wiki-entity-')),
  )

  // Topic is authoritative. Entity is only a fallback selector for Topic sources.
  if (topicAliases.length > 0) {
    return resolveTopic(topicAliases, entityAliases)
  }

  if (entityAliases.length > 0) {
    return resolveEntityViaTopic(entityAliases)
  }

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    mode: 'none',
    topicAliases: [],
    entityAliases: [],
    sourceAliases: [],
  }
}

const writeFocus = async (focus: ResolvedFocus): Promise<void> => {
  await mkdir(dirname(FOCUS_PATH), { recursive: true })
  const temporary = `${FOCUS_PATH}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(focus, null, 2)}\n`, 'utf8')
  await rename(temporary, FOCUS_PATH)
}

export const POST = async (request: NextRequest) => {
  try {
    const body = (await request.json()) as { pages?: WikiPageRef[] }
    const focus = await resolveFocus(Array.isArray(body.pages) ? body.pages : [])
    await writeFocus(focus)
    return NextResponse.json(focus)
  } catch (error) {
    // A graph handoff must never mutate wiki content. Report failure only here;
    // the Wiki Chat client deliberately treats this route as best-effort.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}

export const GET = async () => {
  try {
    const raw = await readFile(FOCUS_PATH, 'utf8')
    return new NextResponse(raw, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    })
  } catch {
    return NextResponse.json({
      version: 1,
      updatedAt: '',
      mode: 'none',
      topicAliases: [],
      entityAliases: [],
      sourceAliases: [],
    })
  }
}
