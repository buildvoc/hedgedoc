import { createHash, randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { NextRequest, NextResponse } from 'next/server'

import {
  type MemexModelSettings,
  readMemexModelSettings,
} from '../memex-model-settings/_settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const WIKI_MAINTAIN_URL = (
  process.env.MEMEX_WIKI_MAINTAIN_URL ??
  'http://127.0.0.1:3101/memex-wiki-maintain'
).replace(/\/+$/, '')
const MEMEX_LOG_PATH =
  process.env.MEMEX_LOG_PATH ?? '/data/projects/hedgedoc/memex/log.md'
const MAX_CONTEXT_PAGES = Math.max(
  1,
  Math.min(24, Number(process.env.MEMEX_WIKI_CONVERSATION_MAX_PAGES ?? '12')),
)
const MAX_CONTEXT_CHARS = Math.max(
  8000,
  Math.min(
    80000,
    Number(process.env.MEMEX_WIKI_CONVERSATION_MAX_CHARS ?? '36000'),
  ),
)
const LLAMACPP_MAX_TOKENS = Math.max(
  1024,
  Math.min(
    16384,
    Number(process.env.MEMEX_WIKI_CONVERSATION_MAX_TOKENS ?? '8192'),
  ),
)
const PAGE_TYPES = new Set([
  'source-summary',
  'entity',
  'topic',
  'comparison',
  'synthesis',
])
const PREVIEW_TTL_MS = Math.max(
  60_000,
  Math.min(
    3_600_000,
    Number(process.env.MEMEX_WIKI_CONVERSATION_PREVIEW_TTL_MS ?? '1800000'),
  ),
)

interface WikiIndexEntry {
  alias: string
  pageType: string
  title: string
  description: string
}

interface LoadedWikiPage extends WikiIndexEntry {
  markdown: string
  sourceAliases: string[]
}

interface ConversationMutation {
  alias?: unknown
  pageType?: unknown
  title?: unknown
  description?: unknown
  tags?: unknown
  sourceAliases?: unknown
  body?: unknown
}

interface ConversationRequest {
  conversation?: unknown
  commit?: unknown
  provenance?: unknown
  targetAliases?: unknown
  previewToken?: unknown
  readOnly?: unknown
}

interface StoredPreview {
  conversation: string
  answer: string
  provenance: string
  pages: Array<Record<string, unknown>>
  responsePages: unknown[]
  snapshots: Record<string, string | null>
  model: string
  provider: string
  expiresAt: number
}

const previewStore = new Map<string, StoredPreview>()

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const markdownHash = (markdown: string): string =>
  createHash('sha256').update(markdown.trim(), 'utf8').digest('hex')

const cleanupExpiredPreviews = (): void => {
  const now = Date.now()
  for (const [token, preview] of previewStore) {
    if (preview.expiresAt <= now) previewStore.delete(token)
  }
}

const normalizePreviewToken = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  const token = value.trim()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    token,
  )
    ? token
    : ''
}

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

const normalizeAlias = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  const alias = value.trim()
  return /^[A-Za-z0-9_-]{1,160}$/.test(alias) ? alias : ''
}

const normalizeTargetAliases = (value: unknown): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('targetAliases must be an array')
  const aliases = value.map(normalizeAlias)
  if (aliases.some((alias) => !alias)) {
    throw new Error('targetAliases contains an invalid alias')
  }
  return [...new Set(aliases)].slice(0, MAX_CONTEXT_PAGES)
}

const normalizeTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(tag)),
    ),
  ].slice(0, 20)
}

const extractSourceAliases = (markdown: string): string[] => {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
  const aliases: string[] = []
  for (const match of frontmatter.matchAll(
    /^\s*-\s*["']?https?:\/\/[^\s"']+\/n\/([A-Za-z0-9_-]{1,160})["']?\s*$/gm,
  )) {
    if (!aliases.includes(match[1])) aliases.push(match[1])
  }
  return aliases
}

const stripJsonFence = (value: string): string =>
  value
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/, '')
    .trim()

const jsonRequest = async (
  url: string,
  options: RequestInit = {},
): Promise<Record<string, unknown>> => {
  const response = await fetch(url, {
    cache: 'no-store',
    ...options,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `Memex wiki HTTP ${response.status}` +
        (text ? `: ${text.slice(0, 300)}` : ''),
    )
  }
  const value: unknown = JSON.parse(text)
  if (!isObject(value)) throw new Error('Memex wiki endpoint returned non-object JSON')
  return value
}

const readCatalogue = async (): Promise<WikiIndexEntry[]> => {
  const result = await jsonRequest(WIKI_MAINTAIN_URL)
  const rawPages = result.pages
  if (!Array.isArray(rawPages)) throw new Error('Memex wiki catalogue pages are invalid')

  return rawPages.flatMap((row) => {
    if (!isObject(row)) return []
    const alias = normalizeAlias(row.alias)
    const pageType = typeof row.pageType === 'string' ? row.pageType.trim() : ''
    const title = typeof row.title === 'string' ? row.title.trim() : ''
    const description =
      typeof row.description === 'string' ? row.description.trim() : ''
    if (!alias || !PAGE_TYPES.has(pageType) || !title) return []
    return [{ alias, pageType, title, description }]
  })
}

const loadWikiPages = async (
  catalogue: WikiIndexEntry[],
  requestedAliases: string[],
): Promise<LoadedWikiPage[]> => {
  const byAlias = new Map(catalogue.map((page) => [page.alias, page]))
  const selected = requestedAliases.length
    ? requestedAliases.map((alias) => {
        const page = byAlias.get(alias)
        if (!page) throw new Error(`Unknown derived wiki target: ${alias}`)
        return page
      })
    : catalogue.slice(0, MAX_CONTEXT_PAGES)

  const loaded: LoadedWikiPage[] = []
  let usedChars = 0
  for (const page of selected) {
    const detail = await jsonRequest(
      `${WIKI_MAINTAIN_URL}?alias=${encodeURIComponent(page.alias)}`,
    )
    if (typeof detail.markdown !== 'string') {
      throw new Error(`Derived wiki page ${page.alias} returned no Markdown`)
    }
    const markdown = detail.markdown.trim()
    if (loaded.length > 0 && usedChars + markdown.length > MAX_CONTEXT_CHARS) break
    loaded.push({
      ...page,
      markdown,
      sourceAliases: extractSourceAliases(markdown),
    })
    usedChars += markdown.length
  }
  return loaded
}

const buildPreviewSnapshots = (
  previewPages: unknown[],
  catalogue: WikiIndexEntry[],
  loadedPages: LoadedWikiPage[],
): Record<string, string | null> => {
  const catalogueAliases = new Set(catalogue.map((page) => page.alias))
  const loadedByAlias = new Map(loadedPages.map((page) => [page.alias, page]))
  const snapshots: Record<string, string | null> = {}

  for (const row of previewPages) {
    if (!isObject(row)) throw new Error('Memex wiki dry-run returned an invalid page')
    const alias = normalizeAlias(row.alias)
    if (!alias) throw new Error('Memex wiki dry-run returned a page without a valid alias')

    if (!catalogueAliases.has(alias)) {
      snapshots[alias] = null
      continue
    }

    const loaded = loadedByAlias.get(alias)
    if (!loaded) {
      throw new Error(`Cannot lock preview for ${alias}: full current page was not loaded`)
    }
    snapshots[alias] = markdownHash(loaded.markdown)
  }

  return snapshots
}

const checkPreviewFresh = async (preview: StoredPreview): Promise<string | null> => {
  const catalogue = await readCatalogue()
  const catalogueAliases = new Set(catalogue.map((page) => page.alias))

  for (const [alias, expectedHash] of Object.entries(preview.snapshots)) {
    if (expectedHash === null) {
      if (catalogueAliases.has(alias)) {
        return `Preview is stale: ${alias} was created after the preview`
      }
      continue
    }

    if (!catalogueAliases.has(alias)) {
      return `Preview is stale: ${alias} is no longer registered`
    }

    const detail = await jsonRequest(
      `${WIKI_MAINTAIN_URL}?alias=${encodeURIComponent(alias)}`,
    )
    if (typeof detail.markdown !== 'string') {
      return `Preview is stale: ${alias} returned no Markdown`
    }
    if (markdownHash(detail.markdown) !== expectedHash) {
      return `Preview is stale: ${alias} changed after the preview`
    }
  }

  return null
}

const extractFirstJsonObject = (value: string): string => {
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') {
        escaped = true
        continue
      }
      if (character === '"') inString = false
      continue
    }

    if (character === '"') {
      inString = true
      continue
    }

    if (character === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }

    if (character === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        return value.slice(start, index + 1)
      }
    }
  }

  return ''
}

const llmChat = async (
  prompt: string,
  settings: MemexModelSettings,
  allowPlainAnswer = false,
): Promise<Record<string, unknown>> => {
  if (prompt.length > settings.maxPromptChars) {
    throw new Error(
      `Conversation maintenance prompt exceeds maxPromptChars (${prompt.length} > ${settings.maxPromptChars})`,
    )
  }

  const baseUrl = settings.baseUrl.replace(/\/+$/, '')
  const messages = [{ role: 'user', content: prompt }]
  let endpoint: string
  let payload: Record<string, unknown>

  if (settings.provider === 'ollama') {
    endpoint = `${baseUrl}/api/chat`
    payload = {
      model: settings.defaultModel,
      messages,
      stream: false,
      format: 'json',
      options: {
        temperature: settings.temperature,
        num_ctx: settings.numCtx,
      },
    }
  } else {
    endpoint = `${baseUrl}/chat/completions`
    payload = {
      model: settings.defaultModel,
      messages,
      stream: false,
      temperature: settings.temperature,
      max_tokens: LLAMACPP_MAX_TOKENS,
      reasoning_effort: 'none',
      cache_prompt: true,
      id_slot: 0,
    }
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(settings.timeoutSeconds * 1000),
    body: JSON.stringify(payload),
  })
  const responseText = await response.text()
  if (!response.ok) {
    throw new Error(
      `${settings.provider} HTTP ${response.status}` +
        (responseText ? `: ${responseText.slice(0, 300)}` : ''),
    )
  }

  const outer: unknown = JSON.parse(responseText)
  if (!isObject(outer)) throw new Error('LLM returned invalid response JSON')

  let content = ''
  if (settings.provider === 'ollama') {
    const message = isObject(outer.message) ? outer.message : null
    content = typeof message?.content === 'string' ? message.content : ''
  } else {
    const choices = Array.isArray(outer.choices) ? outer.choices : []
    const first = isObject(choices[0]) ? choices[0] : null
    const message = first && isObject(first.message) ? first.message : null
    content = typeof message?.content === 'string' ? message.content : ''
  }

  if (!content.trim()) throw new Error('LLM returned empty conversation maintenance output')
  const cleaned = stripJsonFence(content).trim()
  let parsed: unknown = null

  try {
    parsed = JSON.parse(cleaned)
  } catch {
    const extracted = extractFirstJsonObject(cleaned)
    if (extracted) {
      try {
        parsed = JSON.parse(extracted)
      } catch {
        parsed = null
      }
    }
  }

  if (!isObject(parsed)) {
    if (allowPlainAnswer) {
      return { answer: cleaned, pages: [] }
    }
    throw new Error('LLM conversation output must be a JSON object')
  }

  if (
    allowPlainAnswer &&
    (typeof parsed.answer !== 'string' || !parsed.answer.trim())
  ) {
    const alternate = [parsed.response, parsed.content, parsed.message].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    )
    if (alternate) return { ...parsed, answer: alternate, pages: [] }

    if (Array.isArray(parsed.aliases)) {
      const aliases = parsed.aliases.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      )
      return { ...parsed, answer: `ALIASES: ${aliases.join(', ')}`, pages: [] }
    }
  }

  return parsed
}

const buildPrompt = (
  conversation: string,
  catalogue: WikiIndexEntry[],
  loadedPages: LoadedWikiPage[],
  readOnly = false,
): string => {
  const catalogueText = catalogue.length
    ? catalogue
        .map(
          (page) =>
            `- [${page.pageType}] ${page.title} | alias=${page.alias} | ${page.description}`,
        )
        .join('\n')
    : '(empty)'
  const pageText = loadedPages.length
    ? loadedPages
        .map(
          (page) =>
            `=== ${page.pageType} | ${page.title} | alias=${page.alias} ===\n${page.markdown}`,
        )
        .join('\n\n')
    : '(no existing derived wiki pages)'

  if (readOnly) {
    return `You are the read-only query engine for a persistent derived Memex wiki.
Raw HedgeDoc sources are canonical evidence and must never be edited.

READ-ONLY QUERY CONTRACT
- Answer the request using the CURRENT DERIVED WIKI CATALOGUE and FULL CURRENT PAGES below.
- Do not propose, create, revise, or delete wiki pages.
- Do not return a "pages" mutation list.
- Follow the request's requested output shape inside the answer string.
- Return exactly one JSON object and no text before or after it:
  {"answer":"<non-empty answer>"}

CURRENT DERIVED WIKI CATALOGUE
${catalogueText}

FULL CURRENT PAGES
${pageText}

READ-ONLY REQUEST
${conversation}`
  }

  return `You maintain a persistent derived Memex wiki. Raw HedgeDoc source notes are canonical evidence and must never be edited.

The human/assistant conversation below is an instruction and interpretation layer. Answer it, then propose persistent wiki edits only when the conversation materially improves the maintained knowledge base.

RULES
- Existing pages may be edited ONLY when their complete Markdown appears under FULL CURRENT PAGES.
- Preserve supported prior knowledge. Do not erase evidence merely because it was not discussed in this conversation.
- Qualify contradictions, uncertainty, and human interpretation instead of silently turning them into facts.
- Do not invent source evidence, source aliases, quotations, dates, people, places, or relationships.
- For sourceAliases, NEVER copy opaque raw HedgeDoc aliases from YAML.
- Instead use ONLY exact memex-wiki-* aliases shown in FULL CURRENT PAGES whose evidence supports the resulting page.
- The server will deterministically expand those loaded derived-page aliases to canonical raw HedgeDoc evidence aliases.
- Never use a catalogue-only page in sourceAliases unless its complete Markdown appears in FULL CURRENT PAGES.
- A new page is valid when the conversation establishes a durable entity/topic/comparison/synthesis that is worth keeping.
- A source-summary page should only be created or revised when the conversation is specifically about summarizing a source.
- Return the COMPLETE resulting Markdown body for each changed page, without YAML frontmatter. Do not return patches/diffs.
- Prefer updating an existing page to creating a duplicate.
- Zero page edits is valid when the conversation should remain ephemeral.
- Return at most 12 pages.

CURRENT DERIVED WIKI CATALOGUE
${catalogueText}

FULL CURRENT PAGES
${pageText}

CONVERSATION / MAINTENANCE INSTRUCTION
${conversation}

Return JSON only:
{
  "answer": "concise response to the conversation",
  "pages": [
    {
      "alias": "existing alias only when revising a supplied page",
      "pageType": "entity|topic|comparison|synthesis|source-summary",
      "title": "canonical page title",
      "description": "one-line description",
      "tags": ["specific-tag"],
      "sourceAliases": ["exact memex-wiki-* aliases from FULL CURRENT PAGES whose evidence supports this page"],
      "body": "complete resulting Markdown body without YAML frontmatter"
    }
  ]
}`
}

const normalizeMutations = (
  value: unknown,
  catalogue: WikiIndexEntry[],
  loadedPages: LoadedWikiPage[],
): Array<Record<string, unknown>> => {
  if (!Array.isArray(value)) throw new Error('LLM output pages must be an array')
  if (value.length > 12) throw new Error('LLM may change at most 12 wiki pages')

  const catalogueByKey = new Map(
    catalogue.map((page) => [
      `${page.pageType.toLowerCase()}\u0000${page.title.toLowerCase()}`,
      page,
    ]),
  )
  const loadedByAlias = new Map(loadedPages.map((page) => [page.alias, page]))
  const catalogueByAlias = new Map(catalogue.map((page) => [page.alias, page]))
  const knownSources = new Set(loadedPages.flatMap((page) => page.sourceAliases))
  const output: Array<Record<string, unknown>> = []
  const seen = new Set<string>()

  for (const raw of value) {
    if (!isObject(raw)) throw new Error('Every LLM page mutation must be an object')

    const pageType = cleanText(raw.pageType, 'pageType', 40)
    if (!PAGE_TYPES.has(pageType)) throw new Error(`Unsupported pageType: ${pageType}`)
    const title = cleanText(raw.title, 'title', 160)
    const description = cleanText(raw.description, 'description', 500)
    const body = cleanText(raw.body, 'body', 60000)
    if (body.startsWith('---\n') || body.startsWith('---\r\n')) {
      throw new Error('LLM page body must not contain YAML frontmatter')
    }

    let alias = normalizeAlias(raw.alias)
    if (raw.alias !== undefined && !alias) throw new Error('LLM returned invalid alias')

    // New derived pages must not claim an explicit alias. Let the wiki
    // maintainer derive it deterministically from pageType + title.
    if (alias && !catalogueByAlias.has(alias)) {
      if (alias.startsWith('memex-wiki-')) {
        alias = ''
      } else {
        throw new Error(`LLM returned unknown explicit alias: ${alias}`)
      }
    }

    if (!alias) {
      const existing = catalogueByKey.get(
        `${pageType.toLowerCase()}\u0000${title.toLowerCase()}`,
      )
      if (existing) alias = existing.alias
    }

    const existingPage = alias ? loadedByAlias.get(alias) : undefined
    if (alias && !existingPage) {
      throw new Error(
        `Refusing unsafe conversation rewrite of ${alias}: full current page was not supplied`,
      )
    }

    const key = alias || `${pageType.toLowerCase()}\u0000${title.toLowerCase()}`
    if (seen.has(key)) throw new Error(`Duplicate LLM wiki mutation: ${title}`)
    seen.add(key)

    const requestedSources = Array.isArray(raw.sourceAliases)
      ? raw.sourceAliases.map(normalizeAlias).filter(Boolean)
      : []

    // A loaded derived page is context, not canonical evidence.
    // If the LLM cites its memex-wiki-* alias, deterministically expand
    // that alias to the raw source aliases already present in its YAML.
    const resolvedSources: string[] = []
    const unresolvedDerivedSources: string[] = []

    for (const source of requestedSources) {
      if (source.startsWith('memex-wiki-')) {
        const loadedSourcePage = loadedByAlias.get(source)
        if (!loadedSourcePage) {
          unresolvedDerivedSources.push(source)
          continue
        }

        for (const rawSource of loadedSourcePage.sourceAliases) {
          if (!resolvedSources.includes(rawSource)) {
            resolvedSources.push(rawSource)
          }
        }
        continue
      }

      if (!resolvedSources.includes(source)) {
        resolvedSources.push(source)
      }
    }

    if (unresolvedDerivedSources.length > 0) {
      throw new Error(
        `LLM returned unavailable derived wiki aliases as sourceAliases: ${unresolvedDerivedSources.join(', ')}`,
      )
    }

    const unknownSources = resolvedSources.filter(
      (source) => !knownSources.has(source),
    )
    if (unknownSources.length > 0) {
      throw new Error(
        `LLM invented unavailable sourceAliases: ${unknownSources.join(', ')}`,
      )
    }

    const sourceAliases = [
      ...new Set([
        ...(existingPage?.sourceAliases ?? []),
        ...resolvedSources,
      ]),
    ]

    output.push({
      ...(alias ? { alias } : {}),
      pageType,
      title,
      description,
      tags: normalizeTags(raw.tags),
      sourceAliases,
      body,
    })
  }

  return output
}

const appendConversationLog = async (
  conversation: string,
  answer: string,
  aliases: string[],
): Promise<void> => {
  const stamp = new Date().toISOString()
  const oneLine = (value: string, max: number): string => {
    const text = value.replace(/\s+/g, ' ').trim()
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`
  }
  const subject = oneLine(conversation, 120) || '(conversation)'
  const payload = `## [${stamp}] conversation | ${subject}\n\n- query: ${oneLine(conversation, 2000)}\n- status: answered\n- derived wiki pages updated: ${aliases.length}\n- pages: ${aliases.length ? aliases.join(', ') : 'none'}\n- LLM called: preview only; commit reused approved preview\n- via: memex-wiki-conversation\n- summary: ${oneLine(answer, 1000)}\n\n`
  await appendFile(MEMEX_LOG_PATH, payload, 'utf8')
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ConversationRequest
    cleanupExpiredPreviews()

    if (body.commit === true) {
      const previewToken = normalizePreviewToken(body.previewToken)
      if (!previewToken) {
        return NextResponse.json(
          { error: 'commit requires a valid previewToken; preview first' },
          { status: 400 },
        )
      }

      const preview = previewStore.get(previewToken)
      if (!preview || preview.expiresAt <= Date.now()) {
        previewStore.delete(previewToken)
        return NextResponse.json(
          { error: 'Preview is missing or expired; generate a new preview' },
          { status: 409 },
        )
      }

      const staleReason = await checkPreviewFresh(preview)
      if (staleReason) {
        previewStore.delete(previewToken)
        return NextResponse.json({ error: staleReason }, { status: 409 })
      }

      const commitStamp = new Date().toISOString()
      const commitProvenance = cleanText(
        `${preview.provenance} | preview=${previewToken.slice(0, 12)} | commit=${commitStamp}`,
        'provenance',
        240,
      )
      const commitPages = preview.pages.map((page, index) => {
        const responsePage = preview.responsePages[index]
        const alias =
          isObject(responsePage) && typeof responsePage.alias === 'string'
            ? normalizeAlias(responsePage.alias)
            : ''
        const expectedHash = alias ? preview.snapshots[alias] : undefined

        return {
          ...page,
          ...(expectedHash === null
            ? { expectMissing: true }
            : typeof expectedHash === 'string'
              ? { expectedCurrentHash: expectedHash }
              : {}),
        }
      })

      const mutationResult = await jsonRequest(WIKI_MAINTAIN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dryRun: false,
          provenance: commitProvenance,
          pages: commitPages,
        }),
      })

      let logWarning: string | undefined
      const committedPages = Array.isArray(mutationResult.pages)
        ? mutationResult.pages
        : []
      const aliases = committedPages.flatMap((page) =>
        isObject(page) && typeof page.alias === 'string' ? [page.alias] : [],
      )
      try {
        await appendConversationLog(preview.conversation, preview.answer, aliases)
      } catch (error) {
        logWarning =
          error instanceof Error ? error.message : 'Conversation log append failed'
      }

      if (mutationResult.committed === true) previewStore.delete(previewToken)

      return NextResponse.json({
        committed: mutationResult.committed === true,
        dryRun: false,
        answer: preview.answer,
        count: preview.pages.length,
        pages: mutationResult.pages ?? preview.responsePages,
        indexAlias: mutationResult.indexAlias ?? 'memex-wiki-index',
        model: preview.model,
        provider: preview.provider,
        previewToken,
        ...(logWarning ? { logWarning } : {}),
      })
    }

    const conversation = cleanText(body.conversation, 'conversation', 12000)
    const provenance = cleanText(
      body.provenance ?? 'conversation',
      'provenance',
      240,
    )
    const targetAliases = normalizeTargetAliases(body.targetAliases)

    const settings = await readMemexModelSettings()
    const catalogue = await readCatalogue()
    const loadedPages = await loadWikiPages(catalogue, targetAliases)
    const prompt = buildPrompt(conversation, catalogue, loadedPages, body.readOnly === true)
    const llmResult = await llmChat(prompt, settings, body.readOnly === true)
    const answer = cleanText(llmResult.answer, 'LLM answer', 12000)
    if (body.readOnly === true) {
      return NextResponse.json(
        {
          committed: false,
          dryRun: true,
          readOnly: true,
          answer,
          count: 0,
          pages: [],
          model: settings.defaultModel,
          provider: settings.provider,
        },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }

    const pages = normalizeMutations(llmResult.pages, catalogue, loadedPages)

    if (pages.length === 0) {
      return NextResponse.json({
        committed: false,
        dryRun: true,
        answer,
        count: 0,
        pages: [],
        model: settings.defaultModel,
        provider: settings.provider,
      })
    }

    const mutationResult = await jsonRequest(WIKI_MAINTAIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dryRun: true,
        provenance,
        pages,
      }),
    })

    const responsePages = Array.isArray(mutationResult.pages)
      ? mutationResult.pages
      : pages
    const previewToken = randomUUID()
    const previewExpiresAt = Date.now() + PREVIEW_TTL_MS
    previewStore.set(previewToken, {
      conversation,
      answer,
      provenance,
      pages,
      responsePages,
      snapshots: buildPreviewSnapshots(responsePages, catalogue, loadedPages),
      model: settings.defaultModel,
      provider: settings.provider,
      expiresAt: previewExpiresAt,
    })

    return NextResponse.json({
      committed: false,
      dryRun: true,
      answer,
      count: pages.length,
      pages: responsePages,
      indexAlias: mutationResult.indexAlias ?? 'memex-wiki-index',
      model: settings.defaultModel,
      provider: settings.provider,
      previewToken,
      previewExpiresAt: new Date(previewExpiresAt).toISOString(),
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Conversation wiki maintenance failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
