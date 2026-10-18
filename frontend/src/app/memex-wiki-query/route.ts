import { NextRequest, NextResponse } from 'next/server'

import { readMemexModelSettings } from '../memex-model-settings/_settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const WIKI_MAINTAIN_URL = (
  process.env.MEMEX_WIKI_MAINTAIN_URL ??
  'http://127.0.0.1:3101/memex-wiki-maintain'
).replace(/\/+$/, '')

const WIKI_CONVERSATION_URL = (
  process.env.MEMEX_WIKI_CONVERSATION_URL ??
  'http://127.0.0.1:3101/memex-wiki-conversation'
).replace(/\/+$/, '')

const MAX_QUERY_PAGES = Math.max(
  2,
  Math.min(12, Number(process.env.MEMEX_WIKI_QUERY_MAX_PAGES ?? '8')),
)

const MAX_CHAT_TURNS = Math.max(
  2,
  Math.min(12, Number(process.env.MEMEX_WIKI_QUERY_MAX_CHAT_TURNS ?? '8')),
)


type OutputFormat =
  | 'markdown'
  | 'comparison'
  | 'marp'
  | 'matplotlib'
  | 'canvas'

type ChatTurn = {
  role: 'user' | 'assistant'
  content: string
}

type QueryRequest = {
  action?: unknown
  question?: unknown
  history?: unknown
  format?: unknown
  answer?: unknown
  aliases?: unknown
  previewToken?: unknown
}

type WikiIndexEntry = {
  alias: string
  pageType: string
  title: string
  description: string
}

type WikiReferencePage = WikiIndexEntry & {
  sourcePages?: number[]
  sourceAnchor?: string
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const cleanText = (
  value: unknown,
  field: string,
  maximum: number,
): string => {
  if (typeof value !== 'string') throw new Error(`${field} is required`)
  const text = value.trim()
  if (!text) throw new Error(`${field} is required`)
  if (text.length > maximum) throw new Error(`${field} is too long`)
  return text
}

const normalizeFormat = (value: unknown): OutputFormat => {
  const format = typeof value === 'string' ? value.trim() : 'markdown'
  if (
    format === 'markdown' ||
    format === 'comparison' ||
    format === 'marp' ||
    format === 'matplotlib' ||
    format === 'canvas'
  ) {
    return format
  }
  throw new Error('Unsupported query output format')
}

const normalizeHistory = (value: unknown): ChatTurn[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('history must be an array')

  return value
    .flatMap((item): ChatTurn[] => {
      if (!isObject(item)) return []
      const role =
        item.role === 'user' || item.role === 'assistant' ? item.role : null
      const content =
        typeof item.content === 'string' ? item.content.trim().slice(0, 12000) : ''
      return role && content ? [{ role, content }] : []
    })
    .slice(-MAX_CHAT_TURNS)
}

const normalizeAliases = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new Error('aliases must be an array')
  const aliases = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => /^memex-wiki-[A-Za-z0-9_-]{1,150}$/.test(item))
  return [...new Set(aliases)].slice(0, MAX_QUERY_PAGES)
}

const jsonRequest = async (
  url: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> => {
  const response = await fetch(url, {
    ...init,
    cache: 'no-store',
  })
  const body = await response.json().catch(() => null)

  if (!response.ok) {
    const message =
      isObject(body) && typeof body.error === 'string'
        ? body.error
        : `HTTP ${response.status} from ${url}`
    throw new Error(message)
  }

  if (!isObject(body)) throw new Error(`Invalid JSON response from ${url}`)
  return body
}

const parseSourcePageList = (value: string): number[] => {
  const pages: number[] = []

  for (const part of value.split(',')) {
    const range = part.trim().match(/^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/)
    if (!range) continue

    const start = Number(range[1])
    const end = range[2] ? Number(range[2]) : start
    if (start < 1 || end < start || end - start > 500) continue

    for (let page = start; page <= end; page += 1) pages.push(page)
  }

  return pages
}

const extractSourcePages = (markdown: string): number[] => {
  const pages: number[] = []
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
  const frontmatterPages = frontmatter.match(
    /^memex_source_pages:\s*\[([^\]]*)\]\s*$/m,
  )?.[1]

  if (frontmatterPages) pages.push(...parseSourcePageList(frontmatterPages))

  for (const marker of markdown.matchAll(
    /<!--\s*memex-source-pages:\s*([^>]+?)\s*-->/gi,
  )) {
    pages.push(...parseSourcePageList(marker[1]))
  }

  return [...new Set(pages)].sort((left, right) => left - right)
}

const extractSourceAnchor = (markdown: string): string | undefined => {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
  const value = frontmatter.match(/^memex_source_anchor:\s*(.+?)\s*$/m)?.[1]?.trim()
  if (!value) return undefined

  const anchor = value.replace(/^(?:\"([^\"]*)\"|'([^']*)')$/, '$1$2').trim()
  return /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(anchor)
    ? anchor
    : undefined
}

const loadReferencePages = async (
  pages: WikiIndexEntry[],
): Promise<WikiReferencePage[]> =>
  Promise.all(
    pages.map(async (page) => {
      if (page.pageType !== 'source-summary') return page

      try {
        const detail = await jsonRequest(
          `${WIKI_MAINTAIN_URL}?alias=${encodeURIComponent(page.alias)}`,
        )
        if (typeof detail.markdown !== 'string') return page

        const sourcePages = extractSourcePages(detail.markdown)
        const sourceAnchor = extractSourceAnchor(detail.markdown)
        if (!sourcePages.length && !sourceAnchor) return page

        return {
          ...page,
          ...(sourcePages.length ? { sourcePages } : {}),
          ...(sourceAnchor ? { sourceAnchor } : {}),
        }
      } catch {
        // Page provenance is optional UI metadata; never fail Wiki Chat because
        // one reference cannot expose it.
        return page
      }
    }),
  )

const readCatalogue = async (): Promise<WikiIndexEntry[]> => {
  const body = await jsonRequest(WIKI_MAINTAIN_URL)
  const pages = Array.isArray(body.pages) ? body.pages : []

  return pages.flatMap((page) => {
    if (!isObject(page)) return []
    const alias = typeof page.alias === 'string' ? page.alias.trim() : ''
    const pageType = typeof page.pageType === 'string' ? page.pageType.trim() : ''
    const title = typeof page.title === 'string' ? page.title.trim() : ''
    const description =
      typeof page.description === 'string' ? page.description.trim() : ''

    if (!alias.startsWith('memex-wiki-') || !pageType || !title) return []
    return [{ alias, pageType, title, description }]
  })
}

const formatHistory = (history: ChatTurn[]): string =>
  history.length
    ? history
        .map(
          (turn) =>
            `${turn.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${turn.content}`,
        )
        .join('\n\n')
    : '(no earlier turns)'

const lexicalFallback = (
  question: string,
  history: ChatTurn[],
  catalogue: WikiIndexEntry[],
): string[] => {
  const searchText = [
    ...history.slice(-4).map((turn) => turn.content),
    question,
  ].join(' ')

  const terms = [
    ...new Set(
      searchText
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((term) => term.length >= 3),
    ),
  ]

  const scored = catalogue
    .map((page) => {
      const haystack =
        `${page.title} ${page.description} ${page.pageType} ${page.alias}`.toLowerCase()
      const score = terms.reduce(
        (sum, term) => sum + (haystack.includes(term) ? 1 : 0),
        0,
      )
      return { alias: page.alias, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.alias.localeCompare(b.alias))
    .slice(0, MAX_QUERY_PAGES)
    .map((item) => item.alias)

  return scored.length
    ? scored
    : catalogue.slice(0, MAX_QUERY_PAGES).map((page) => page.alias)
}

const conversation = async (
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  jsonRequest(WIKI_CONVERSATION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

const conversationStream = async (
  payload: Record<string, unknown>,
): Promise<Response> => {
  const response = await fetch(WIKI_CONVERSATION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      readOnly: true,
      commit: false,
      stream: true,
    }),
    cache: 'no-store',
  })

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const message =
      isObject(body) && typeof body.error === 'string'
        ? body.error
        : `HTTP ${response.status} from ${WIKI_CONVERSATION_URL}`
    throw new Error(message)
  }
  if (!response.body) throw new Error('Streaming Memex response has no body')
  return response
}

const retryableReadOnlyError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('Unexpected non-whitespace character after JSON') ||
    message.includes('LLM answer is required') ||
    message.includes('LLM conversation output must be a JSON object') ||
    message.includes('Unexpected token') ||
    message.includes('Invalid JSON') ||
    message.includes('Read-only Memex response did not contain an answer')
  )
}

const conversationReadOnly = async (
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const run = async (retry: boolean): Promise<Record<string, unknown>> => {
    const conversationText =
      typeof payload.conversation === 'string' ? payload.conversation : ''
    const result = await conversation({
      ...payload,
      readOnly: true,
      commit: false,
      conversation: retry
        ? `${conversationText}

RETRY CONTRACT:
Return exactly one JSON object with one non-empty string field named "answer".
Do not append commentary before or after the JSON object.`
        : conversationText,
    })

    if (typeof result.answer !== 'string' || !result.answer.trim()) {
      throw new Error('Read-only Memex response did not contain an answer')
    }
    return result
  }

  try {
    return await run(false)
  } catch (error) {
    if (!retryableReadOnlyError(error)) throw error
    return run(true)
  }
}

const searchWiki = (
  question: string,
  history: ChatTurn[],
  catalogue: WikiIndexEntry[],
): { aliases: string[]; retrieval: 'lexical' } => ({
  // Wiki Chat deliberately keeps retrieval off llama.cpp. With --parallel 1, an
  // intermediate retrieval prompt would replace slot 0 immediately before the
  // answer call and destroy the answer prompt's reusable live KV prefix.
  aliases: lexicalFallback(question, history, catalogue).sort((left, right) =>
    left.localeCompare(right),
  ),
  retrieval: 'lexical',
})

const formatInstruction = (format: OutputFormat): string => {
  switch (format) {
    case 'comparison':
      return `Return a concise Markdown comparison with a clear comparison table,
followed by the most important similarities, differences, and uncertainties.`
    case 'marp':
      return `Return a complete Marp slide deck as Markdown. Include the Marp
frontmatter and slide separators. Keep citations visible on the relevant slides.`
    case 'matplotlib':
      return `Return a short explanation followed by a complete Python matplotlib
code block that generates the requested chart from values actually supported by
the loaded wiki pages. Do not fabricate missing numeric data. Put citations and
data provenance outside the code block.`
    case 'canvas':
      return `Return a structured Markdown working canvas: question, key findings,
evidence, connections, uncertainties, and follow-up questions.`
    default:
      return `Return a natural conversational Markdown answer. Follow the user's
requested style, including bullets when requested.`
  }
}

const answerQuery = async (
  question: string,
  history: ChatTurn[],
  format: OutputFormat,
  aliases: string[],
): Promise<Record<string, unknown>> => {
  const citationList = aliases.map((alias) => `- ${alias}`).join('\n')
  const instruction = `WIKI RAG ANSWER MODE.

You are answering a user in a chat interface using the maintained Memex wiki as
retrieval-augmented context. Use ONLY the FULL CURRENT PAGES loaded for this
request as factual wiki evidence. This call is server-enforced read-only.

RECENT CHAT
${formatHistory(history)}

LATEST QUESTION
${question}

Required output:
${formatInstruction(format)}

Citation rules:
- Cite substantive claims inline with Markdown links to the exact loaded wiki page:
  [page title](/n/exact-memex-wiki-alias)
- Never cite a page that was not loaded.
- Do not invent citations, source aliases, facts, dates, relationships, or numbers.
- State uncertainty when the loaded pages do not support a definite answer.
- The loaded aliases available for citation are:
${citationList}
`

  return conversationReadOnly({
    provenance: `wiki-query-rag-answer ${new Date().toISOString()}`,
    targetAliases: aliases,
    conversation: instruction,
  })
}

const answerQueryStream = async (
  question: string,
  history: ChatTurn[],
  format: OutputFormat,
  aliases: string[],
): Promise<Response> => {
  const citationList = aliases.map((alias) => `- ${alias}`).join('\n')
  const instruction = `WIKI RAG ANSWER MODE.

You are answering a user in a chat interface using the maintained Memex wiki as
retrieval-augmented context. Use ONLY the FULL CURRENT PAGES loaded for this
request as factual wiki evidence. This call is server-enforced read-only.

RECENT CHAT
${formatHistory(history)}

LATEST QUESTION
${question}

Required output:
${formatInstruction(format)}

Reference rules:
- The UI shows the loaded wiki pages separately as references, so do not add
  inline wiki citation links solely for attribution.
- Never rely on a page that was not loaded.
- Do not invent source aliases, facts, dates, relationships, or numbers.
- State uncertainty when the loaded pages do not support a definite answer.
- The loaded aliases available as evidence are:
${citationList}
`

  return conversationStream({
    provenance: `wiki-query-rag-answer ${new Date().toISOString()}`,
    targetAliases: aliases,
    conversation: instruction,
  })
}

const streamQueryResponse = (
  upstream: Response,
  metadata: Record<string, unknown>,
): Response => {
  if (!upstream.body) throw new Error('Streaming Memex response has no body')

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const source = upstream.body

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader()
      const send = (event: Record<string, unknown>): void => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      }

      send({ type: 'meta', ...metadata })

      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break

          const delta = decoder.decode(value, { stream: true })
          if (delta) send({ type: 'delta', delta })
        }

        const tail = decoder.decode()
        if (tail) send({ type: 'delta', delta: tail })
        send({ type: 'done' })
        controller.close()
      } catch (error) {
        send({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
        controller.close()
      } finally {
        reader.releaseLock()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'X-Accel-Buffering': 'no',
    },
  })
}

const stripInlineWikiCitations = (
  answer: string,
  pages: WikiIndexEntry[],
): string => {
  let cleaned = answer

  for (const page of pages) {
    const title = page.title.trim()
    const alias = page.alias.trim()
    if (!alias) continue

    const esc = (value: string): string =>
      value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    const aliasPattern = esc(alias)
    const titlePattern = title ? esc(title) : ''

    cleaned = cleaned.replace(
      new RegExp(
        `\\s*\\[[^\\]\\n]+\\]\\(\\/(?:n\\/)?${aliasPattern}\\)`,
        'g',
      ),
      '',
    )

    cleaned = cleaned.replace(
      new RegExp(`\\s*\\[\\[${aliasPattern}\\]\\]`, 'g'),
      '',
    )
    cleaned = cleaned.replace(
      new RegExp(`\\s*\\[${aliasPattern}\\](?!\\()`, 'g'),
      '',
    )

    if (titlePattern) {
      cleaned = cleaned.replace(
        new RegExp(`\\s*\\[\\[${titlePattern}\\]\\]`, 'g'),
        '',
      )
      cleaned = cleaned.replace(
        new RegExp(`\\s*\\[${titlePattern}\\](?!\\()`, 'g'),
        '',
      )
    }
  }

  return cleaned
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/([,.;:!?])(?=[A-Za-z0-9])/g, '$1 ')
    .replace(/[ \t]{2,}/g, ' ')
}

const filePreview = async (
  question: string,
  answer: string,
  format: OutputFormat,
  aliases: string[],
): Promise<Record<string, unknown>> => {
  if (aliases.length === 0) {
    throw new Error('Cannot file an answer without supporting wiki pages')
  }

  const sourceList = aliases.map((alias) => `- ${alias}`).join('\n')
  const pageType = format === 'comparison' ? 'comparison' : 'synthesis'

  const instruction = `FILE A QUERY ANSWER INTO THE PERSISTENT MEMEX WIKI.

Create exactly ONE durable ${pageType} page from the query and answer below.
This is a filing operation, not a new research step.

Question:
${question}

Answer to file:
${answer}

Rules:
- pageType must be "${pageType}".
- For a NEW page, omit alias entirely.
- Do not edit source-summary, entity, or topic pages.
- sourceAliases MUST contain one or more exact loaded derived aliases from:
${sourceList}
- Never copy opaque raw HedgeDoc aliases from YAML. The server will expand the
  loaded memex-wiki-* aliases to canonical raw evidence.
- Preserve the useful citations from the answer.
- Do not add claims not already supported by the loaded pages.
- Proofread the title.
- If the answer is a Marp deck, store it inside a fenced Markdown code block so
  the page body does not begin with YAML frontmatter.
- If the answer is matplotlib code, retain the code and its evidence/citation notes.
- Return exactly one page mutation.
`

  const result = await conversation({
    commit: false,
    provenance: `wiki-query-file ${new Date().toISOString()}`,
    targetAliases: aliases,
    conversation: instruction,
  })

  const pages = Array.isArray(result.pages) ? result.pages : []
  if (pages.length === 0) {
    return {
      ...result,
      noChange: true,
      answer:
        typeof result.answer === 'string' && result.answer.trim()
          ? result.answer
          : 'No durable wiki page was proposed for this answer.',
      pages: [],
    }
  }
  if (pages.length !== 1 || !isObject(pages[0])) {
    throw new Error('Filing preview may contain at most one wiki page')
  }

  const filedType =
    typeof pages[0].pageType === 'string' ? pages[0].pageType : ''
  if (filedType !== pageType) {
    throw new Error(`Filing preview returned unexpected pageType: ${filedType}`)
  }

  const sources = Array.isArray(pages[0].sourceAliases)
    ? pages[0].sourceAliases.filter(
        (value): value is string =>
          typeof value === 'string' && value.trim().length > 0,
      )
    : []

  if (sources.length === 0) {
    throw new Error('Refusing filing preview with empty canonical evidence')
  }

  return result
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as QueryRequest
    const action =
      typeof body.action === 'string' ? body.action.trim() : 'query'

    if (action === 'commit') {
      const previewToken = cleanText(body.previewToken, 'previewToken', 500)
      const result = await conversation({
        commit: true,
        previewToken,
      })
      return NextResponse.json(result, {
        headers: { 'Cache-Control': 'no-store' },
      })
    }

    const question = cleanText(body.question, 'question', 12000)
    const history = normalizeHistory(body.history)
    const format = normalizeFormat(body.format)

    if (action === 'file-preview') {
      const answer = cleanText(body.answer, 'answer', 50000)
      const aliases = normalizeAliases(body.aliases)
      const result = await filePreview(question, answer, format, aliases)
      return NextResponse.json(result, {
        headers: { 'Cache-Control': 'no-store' },
      })
    }

    if (action !== 'query') throw new Error('Unsupported query action')

    const catalogue = await readCatalogue()
    if (catalogue.length === 0) {
      throw new Error('The maintained Memex wiki catalogue is empty')
    }

    const retrievalResult = searchWiki(question, history, catalogue)
    const aliases = retrievalResult.aliases

    const byAlias = new Map(catalogue.map((page) => [page.alias, page]))
    const pages = await loadReferencePages(
      aliases.flatMap((alias) => {
        const page = byAlias.get(alias)
        return page ? [page] : []
      }),
    )

    const settings = await readMemexModelSettings()
    if (settings.streamChatResponses) {
      const upstream = await answerQueryStream(question, history, format, aliases)
      return streamQueryResponse(upstream, {
        format,
        aliases,
        pages,
        readOnly: true,
        model: settings.defaultModel,
        provider: settings.provider,
        retrieval: retrievalResult.retrieval,
      })
    }

    const result = await answerQuery(question, history, format, aliases)
    const rawAnswer =
      typeof result.answer === 'string'
        ? result.answer
        : 'The query returned no answer.'
    const answer = stripInlineWikiCitations(rawAnswer, pages)

    return NextResponse.json(
      {
        answer,
        format,
        aliases,
        pages,
        readOnly: result.readOnly === true,
        model: result.model,
        provider: result.provider,
        retrieval: retrievalResult.retrieval,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Memex wiki query failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
