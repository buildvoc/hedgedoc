import { NextRequest, NextResponse } from 'next/server'

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

const ALIAS_PATTERN = /memex-wiki-[a-z0-9_-]{1,150}/g

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

const searchWiki = async (
  question: string,
  history: ChatTurn[],
  catalogue: WikiIndexEntry[],
): Promise<{ aliases: string[]; retrieval: 'llm' | 'lexical' }> => {
  const searchInstruction = `WIKI RAG RETRIEVAL ONLY.

Use the CURRENT DERIVED WIKI CATALOGUE supplied to you as the retrieval index.
Select the existing wiki pages that should be read in full to answer the user's
latest question in the context of the recent chat.

RECENT CHAT
${formatHistory(history)}

LATEST QUESTION
${question}

Rules:
- This is retrieval only, not wiki maintenance.
- Do NOT answer the question yet.
- Return at most ${MAX_QUERY_PAGES} exact existing memex-wiki-* aliases.
- Prefer topic/entity/synthesis/comparison pages, and include source-summary pages
  when they contain important supporting evidence.
- In your answer write exactly:
ALIASES: alias1, alias2, alias3
- If nothing is relevant write:
ALIASES:
`

  try {
    const result = await conversationReadOnly({
      provenance: `wiki-query-rag-retrieval ${new Date().toISOString()}`,
      targetAliases: [],
      conversation: searchInstruction,
    })

    const answer = typeof result.answer === 'string' ? result.answer : ''
    const known = new Set(catalogue.map((page) => page.alias))
    const selected = [...new Set(answer.match(ALIAS_PATTERN) ?? [])]
      .filter((alias) => known.has(alias))
      .slice(0, MAX_QUERY_PAGES)

    if (selected.length) return { aliases: selected, retrieval: 'llm' }
  } catch {
    // A retrieval-only model formatting failure must not break the whole chat.
  }

  return {
    aliases: lexicalFallback(question, history, catalogue),
    retrieval: 'lexical',
  }
}

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

    const retrievalResult = await searchWiki(question, history, catalogue)
    const aliases = retrievalResult.aliases
    const result = await answerQuery(question, history, format, aliases)

    const byAlias = new Map(catalogue.map((page) => [page.alias, page]))
    const pages = aliases.flatMap((alias) => {
      const page = byAlias.get(alias)
      return page ? [page] : []
    })

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
