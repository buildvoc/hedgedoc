'use client'

import {
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

type OutputFormat =
  | 'markdown'
  | 'comparison'
  | 'marp'
  | 'matplotlib'
  | 'canvas'

type WikiPage = {
  alias: string
  pageType: string
  title: string
  description?: string
}

type QueryResult = {
  answer: string
  format: OutputFormat
  aliases: string[]
  pages: WikiPage[]
  readOnly?: boolean
  model?: string
  provider?: string
  retrieval?: 'llm' | 'lexical'
}

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  selectionContext?: string
  question?: string
  format?: OutputFormat
  aliases?: string[]
  pages?: WikiPage[]
  model?: string
  provider?: string
  retrieval?: 'llm' | 'lexical'
}

type FilingPreview = {
  previewToken?: string
  committed?: boolean
  count?: number
  noChange?: boolean
  pages?: Array<{
    alias?: string
    pageType?: string
    title?: string
    sourceAliases?: string[]
  }>
  answer?: string
}

type Props = {
  standalone?: boolean
}

type SelectionAction = {
  text: string
  left: number
  top: number
}

const FORMATS: Array<{ value: OutputFormat; label: string }> = [
  { value: 'markdown', label: 'Normal answer' },
  { value: 'comparison', label: 'Comparison' },
  { value: 'marp', label: 'Marp slides' },
  { value: 'matplotlib', label: 'Matplotlib' },
  { value: 'canvas', label: 'Canvas' },
]

const newId = (): string =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

const renderInline = (content: string, keyPrefix: string): ReactNode[] => {
  const tokenPattern =
    /(\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\n]+)\*)/g
  const output: ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  let token = 0

  while ((match = tokenPattern.exec(content)) !== null) {
    if (match.index > cursor) output.push(content.slice(cursor, match.index))

    if (match[2] && match[3]) {
      const href = match[3]
      const safeHref =
        href.startsWith('/n/memex-wiki-') ||
        href.startsWith('http://') ||
        href.startsWith('https://')
          ? href
          : ''
      output.push(
        safeHref ? (
          <a
            key={`${keyPrefix}-link-${token}`}
            href={safeHref}
            target='_blank'
            rel='noreferrer'>
            {match[2]}
          </a>
        ) : (
          match[2]
        ),
      )
    } else if (match[4]) {
      output.push(
        <strong key={`${keyPrefix}-strong-${token}`}>{match[4]}</strong>,
      )
    } else if (match[5]) {
      output.push(<code key={`${keyPrefix}-code-${token}`}>{match[5]}</code>)
    } else if (match[6]) {
      output.push(<em key={`${keyPrefix}-em-${token}`}>{match[6]}</em>)
    }

    token += 1
    cursor = match.index + match[0].length
  }

  if (cursor < content.length) output.push(content.slice(cursor))
  return output
}

const renderAnswer = (content: string): ReactNode[] => {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const output: ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (!line.trim()) {
      index += 1
      continue
    }

    if (line.trim().startsWith('```')) {
      const language = line.trim().slice(3).trim()
      const code: string[] = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        code.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      output.push(
        <pre
          key={`code-${index}`}
          style={{
            overflowX: 'auto',
            padding: '0.75rem',
            borderRadius: '0.4rem',
            background: 'var(--bs-tertiary-bg, rgba(0,0,0,.04))',
          }}>
          <code>
            {language ? `${language}\n` : ''}
            {code.join('\n')}
          </code>
        </pre>,
      )
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      output.push(
        <div
          key={`heading-${index}`}
          style={{
            fontSize: heading[1].length <= 2 ? '1.08rem' : '1rem',
            fontWeight: 650,
            margin: '0.9rem 0 0.35rem',
          }}>
          {renderInline(heading[2], `heading-${index}`)}
        </div>,
      )
      index += 1
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ''))
        index += 1
      }
      output.push(
        <ul key={`ul-${index}`} style={{ margin: '0.4rem 0 0.7rem' }}>
          {items.map((item, itemIndex) => (
            <li key={`ul-${index}-${itemIndex}`}>
              {renderInline(item, `ul-${index}-${itemIndex}`)}
            </li>
          ))}
        </ul>,
      )
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ''))
        index += 1
      }
      output.push(
        <ol key={`ol-${index}`} style={{ margin: '0.4rem 0 0.7rem' }}>
          {items.map((item, itemIndex) => (
            <li key={`ol-${index}-${itemIndex}`}>
              {renderInline(item, `ol-${index}-${itemIndex}`)}
            </li>
          ))}
        </ol>,
      )
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const quotes: string[] = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quotes.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      output.push(
        <blockquote
          key={`quote-${index}`}
          style={{
            margin: '0.5rem 0',
            paddingLeft: '0.75rem',
            borderLeft: '3px solid var(--bs-border-color, #ced4da)',
          }}>
          {renderInline(quotes.join(' '), `quote-${index}`)}
        </blockquote>,
      )
      continue
    }

    const paragraph: string[] = [line.trim()]
    index += 1
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^\s*[-*+]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index]) &&
      !lines[index].trim().startsWith('```')
    ) {
      paragraph.push(lines[index].trim())
      index += 1
    }

    output.push(
      <p key={`p-${index}`} style={{ margin: '0.35rem 0 0.7rem' }}>
        {renderInline(paragraph.join(' '), `p-${index}`)}
      </p>,
    )
  }

  return output
}

export const MemexWikiQueryPanel = ({ standalone = false }: Props) => {
  const [input, setInput] = useState('')
  const [format, setFormat] = useState<OutputFormat>('markdown')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [filing, setFiling] = useState<FilingPreview | null>(null)
  const [filingTargetId, setFilingTargetId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selectionAction, setSelectionAction] =
    useState<SelectionAction | null>(null)
  const [selectionContext, setSelectionContext] = useState('')
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const canCommit = Boolean(filing?.previewToken) && !busy

  useEffect(() => {
    if (!messagesEndRef.current || busy) return

    const frame = window.requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({
        behavior: messages.length > 1 ? 'smooth' : 'auto',
        block: 'end',
      })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [messages, busy])

  useEffect(() => {
    if (!error) return
    const timer = window.setTimeout(() => setError(''), 12000)
    return () => window.clearTimeout(timer)
  }, [error])

  const captureSelection = () => {
    if (busy) {
      setSelectionAction(null)
      return
    }

    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setSelectionAction(null)
      return
    }

    const text = selection.toString().trim().slice(0, 4000)
    if (!text) {
      setSelectionAction(null)
      return
    }

    const range = selection.getRangeAt(0)
    const common =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement

    const answer = common?.closest('[data-memex-answer="true"]')
    if (!answer) {
      setSelectionAction(null)
      return
    }

    const rect = range.getBoundingClientRect()
    if (!rect.width && !rect.height) {
      setSelectionAction(null)
      return
    }

    setSelectionAction({
      text,
      left: Math.min(
        window.innerWidth - 72,
        Math.max(72, rect.left + rect.width / 2),
      ),
      top: Math.min(
        window.innerHeight - 48,
        Math.max(8, rect.bottom + 8),
      ),
    })
  }

  const useHighlightedText = () => {
    if (!selectionAction?.text) return
    setSelectionContext(selectionAction.text)
    setSelectionAction(null)
    window.getSelection()?.removeAllRanges()
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const callQuery = async (
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const response = await fetch('/memex-wiki-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await response.json().catch(() => null)

    if (!response.ok) {
      throw new Error(
        typeof body?.error === 'string'
          ? body.error
          : `Memex wiki query failed with HTTP ${response.status}`,
      )
    }

    if (!body || typeof body !== 'object') {
      throw new Error('Memex wiki query returned an invalid response')
    }

    return body as Record<string, unknown>
  }

  const publishGraphFocus = async (pages: WikiPage[]) => {
    try {
      await fetch('/memex-wiki-graph-focus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pages }),
      })
    } catch {
      // Graph focus is advisory UI state; never fail Wiki Chat because of it.
    }
  }

  const ask = async () => {
    const question = input.trim()
    if (!question || busy) return

    const queryQuestion = selectionContext
      ? `Regarding this highlighted passage from the current chat:

"${selectionContext}"

${question}`
      : question

    const history = messages.map((message) => ({
      role: message.role,
      content: message.content,
    }))
    const userMessage: ChatMessage = {
      id: newId(),
      role: 'user',
      content: question,
      selectionContext: selectionContext || undefined,
    }

    setMessages((current) => [...current, userMessage])
    setInput('')
    setSelectionContext('')
    setSelectionAction(null)
    setBusy(true)
    setError('')
    setFiling(null)
    setFilingTargetId('')

    try {
      const body = (await callQuery({
        action: 'query',
        question: queryQuestion,
        history,
        format,
      })) as unknown as QueryResult

      const answer =
        typeof body.answer === 'string' ? body.answer.trim() : ''
      if (!answer) {
        throw new Error('Memex returned an empty answer. Please try again.')
      }

      const assistantMessage: ChatMessage = {
        id: newId(),
        role: 'assistant',
        content: answer,
        question,
        format: body.format,
        aliases: Array.isArray(body.aliases) ? body.aliases : [],
        pages: Array.isArray(body.pages) ? body.pages : [],
        model: body.model,
        provider: body.provider,
        retrieval: body.retrieval,
      }

      setMessages((current) => [...current, assistantMessage])
      void publishGraphFocus(assistantMessage.pages ?? [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const previewFiling = async (message: ChatMessage) => {
    if (
      message.role !== 'assistant' ||
      !message.question ||
      !message.format ||
      !message.aliases?.length ||
      busy
    ) {
      return
    }

    setBusy(true)
    setError('')
    setFiling(null)
    setFilingTargetId(message.id)

    try {
      const body = await callQuery({
        action: 'file-preview',
        question: message.question,
        format: message.format,
        answer: message.content,
        aliases: message.aliases,
      })
      setFiling(body as unknown as FilingPreview)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const commitFiling = async () => {
    if (!filing?.previewToken || busy) return

    setBusy(true)
    setError('')

    try {
      const body = await callQuery({
        action: 'commit',
        previewToken: filing.previewToken,
      })
      setFiling(body as unknown as FilingPreview)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const copyAnswer = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content)
    } catch {
      setError('Could not copy the answer to the clipboard.')
    }
  }

  const clearChat = () => {
    if (busy) return
    setMessages([])
    setInput('')
    setSelectionContext('')
    setSelectionAction(null)
    setError('')
    setFiling(null)
    setFilingTargetId('')
    void publishGraphFocus([])
  }

  const filedPages = useMemo(
    () => (Array.isArray(filing?.pages) ? filing?.pages ?? [] : []),
    [filing],
  )

  return (
    <section
      aria-label='LLM wiki RAG chat'
      onMouseUp={captureSelection}
      onKeyUp={captureSelection}
      style={{
        border: standalone
          ? 'none'
          : '1px solid var(--bs-border-color, #ced4da)',
        borderRadius: '0.65rem',
        padding: standalone ? 0 : '1rem',
        marginTop: standalone ? 0 : '1rem',
        display: standalone ? 'flex' : 'block',
        flexDirection: standalone ? 'column' : undefined,
        minHeight: standalone ? 'calc(100vh - 2rem)' : undefined,
      }}>
      <style>{`
        @keyframes memexThinkingDot {
          0%, 80%, 100% {
            transform: translateY(0);
            opacity: 0.35;
          }
          40% {
            transform: translateY(-4px);
            opacity: 1;
          }
        }

        @keyframes memexThinkingPulse {
          0%, 100% {
            box-shadow: 0 0 0 0 rgba(118, 185, 0, 0.18);
          }
          50% {
            box-shadow: 0 0 0 6px rgba(118, 185, 0, 0);
          }
        }
      `}</style>

      {selectionAction ? (
        <button
          type='button'
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onMouseUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            useHighlightedText()
          }}
          style={{
            position: 'fixed',
            left: selectionAction.left,
            top: selectionAction.top,
            transform: 'translateX(-50%)',
            zIndex: 1000,
            borderRadius: '0.55rem',
            padding: '0.4rem 0.7rem',
            boxShadow: '0 2px 10px rgba(0, 0, 0, 0.16)',
            background: 'var(--bs-body-bg, white)',
            color: 'inherit',
            border: '1px solid var(--bs-border-color, #ced4da)',
            fontWeight: 600,
          }}>
          Ask Wiki
        </button>
      ) : null}

      {!standalone ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '0.75rem',
            flexWrap: 'wrap',
            alignItems: 'center',
            paddingBottom: '0.8rem',
            borderBottom: '1px solid var(--bs-border-color, #ced4da)',
          }}>
          <div>
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}>
              <h2 style={{ fontSize: '1.2rem', margin: 0 }}>Wiki chat</h2>
              <span
                style={{
                  fontSize: '0.78rem',
                  border: '1px solid var(--bs-border-color, #ced4da)',
                  borderRadius: '999px',
                  padding: '0.15rem 0.45rem',
                }}>
                LLM + Wiki RAG
              </span>
            </div>
            <p style={{ margin: '0.35rem 0 0', opacity: 0.8 }}>
              Memex selects relevant maintained wiki pages, reads them in full,
              and answers from that evidence.
            </p>
          </div>

          <button
            type='button'
            disabled={busy || messages.length === 0}
            onClick={clearChat}>
            New chat
          </button>
        </div>
      ) : null}

      {error ? (
        <div
          role='alert'
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '0.75rem',
            alignItems: 'start',
            marginTop: '0.8rem',
            padding: '0.7rem 0.8rem',
            border: '1px solid var(--bs-danger-border-subtle, #f1aeb5)',
            borderRadius: '0.5rem',
            background: 'var(--bs-danger-bg-subtle, #f8d7da)',
          }}>
          <span>{error}</span>
          <button
            type='button'
            aria-label='Dismiss error'
            onClick={() => setError('')}>
            ×
          </button>
        </div>
      ) : null}

      {standalone ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '0.75rem',
            marginBottom: '0.65rem',
          }}>
          <select
            aria-label='Answer format'
            title='Answer format'
            value={format}
            onChange={(event) => setFormat(event.target.value as OutputFormat)}
            style={{
              flex: '0 0 auto',
              maxWidth: '9.5rem',
              height: '2.35rem',
              borderRadius: '0.55rem',
              padding: '0 0.45rem',
            }}>
            {FORMATS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>

          <button
            type='button'
            disabled={busy || messages.length === 0}
            onClick={clearChat}>
            New chat
          </button>
        </div>
      ) : null}

      <div
        aria-live='polite'
        style={{
          marginTop: standalone ? 0 : '0.9rem',
          minHeight: standalone ? '24rem' : undefined,
          maxHeight: standalone ? undefined : '42rem',
          flex: standalone ? undefined : undefined,
          overflowY: standalone ? 'visible' : 'auto',
          display: 'grid',
          alignContent: 'start',
          gap: '0.9rem',
          paddingRight: standalone ? 0 : '0.25rem',
        }}>
        {messages.length === 0 ? (
          <div
            style={{
              padding: '1.2rem',
              border: '1px dashed var(--bs-border-color, #ced4da)',
              borderRadius: '0.65rem',
              maxWidth: '44rem',
            }}>
            <strong>Ask the maintained wiki</strong>
            <p style={{ margin: '0.4rem 0 0' }}>
              Follow-up questions keep recent chat context while Memex performs
              fresh RAG retrieval for each question.
            </p>
          </div>
        ) : null}

        {messages.map((message) => {
          const assistant = message.role === 'assistant'
          const isFilingTarget = filingTargetId === message.id

          return (
            <div
              key={message.id}
              style={{
                display: 'flex',
                justifyContent: assistant ? 'flex-start' : 'flex-end',
              }}>
              <div
                style={{
                  width: assistant ? '100%' : 'min(46rem, 86%)',
                  border: '1px solid var(--bs-border-color, #ced4da)',
                  borderRadius: '0.8rem',
                  padding: '0.9rem 1rem',
                  background: assistant
                    ? 'var(--bs-body-bg, transparent)'
                    : 'var(--bs-tertiary-bg, rgba(0,0,0,.04))',
                }}>

                {!assistant ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.6rem',
                      minWidth: 0,
                      width: '100%',
                    }}>
                    {message.selectionContext ? (
                      <span
                        title={message.selectionContext}
                        style={{
                          flex: '0 1 auto',
                          width: 'fit-content',
                          minWidth: 0,
                          maxWidth: 'min(58%, 28rem)',
                          padding: '0.22rem 0.55rem',
                          borderRadius: '999px',
                          background: 'rgba(127, 127, 127, 0.08)',
                          border: '1px solid rgba(127, 127, 127, 0.14)',
                          fontSize: '0.8rem',
                          lineHeight: 1.25,
                          opacity: 0.82,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                        <strong>{message.selectionContext}</strong>
                      </span>
                    ) : null}

                    <div
                      style={{
                        flex: '1 1 auto',
                        minWidth: 0,
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'anywhere',
                        lineHeight: 1.45,
                      }}>
                      {message.content}
                    </div>
                  </div>
                ) : (
                  <div
                    data-memex-answer='true'
                    style={{
                      whiteSpace: 'normal',
                      overflowWrap: 'anywhere',
                      lineHeight: 1.55,
                    }}>
                    {renderAnswer(message.content)}
                  </div>
                )}

                {assistant ? (
                  <div
                    style={{
                      position: 'relative',
                      marginTop: '0.5rem',
                      borderTop: '1px solid var(--bs-border-color, #ced4da)',
                      paddingTop: '0.42rem',
                      minHeight: '1.8rem',
                    }}>
                    {message.pages?.length ? (
                      <details>
                        <summary
                          style={{
                            cursor: 'pointer',
                            fontWeight: 600,
                            paddingRight: '4.4rem',
                            lineHeight: '1.7rem',
                          }}>
                          Show references ({message.pages.length})
                        </summary>
                        <div
                          style={{
                            display: 'grid',
                            gap: '0.5rem',
                            marginTop: '0.55rem',
                            paddingRight: '0.1rem',
                          }}>
                          {message.pages.map((page) => (
                            <div
                              key={page.alias}
                              style={{
                                borderTop:
                                  '1px solid var(--bs-border-color, #ced4da)',
                                paddingTop: '0.45rem',
                              }}>
                              <div
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  gap: '0.75rem',
                                  flexWrap: 'wrap',
                                  alignItems: 'baseline',
                                }}>
                                <strong>{page.title}</strong>
                                <a
                                  href={`/n/${encodeURIComponent(page.alias)}`}
                                  target='_blank'
                                  rel='noreferrer'>
                                  Open source
                                </a>
                              </div>
                              <div style={{ marginTop: '0.15rem', opacity: 0.7 }}>
                                {page.pageType} · {page.alias}
                              </div>
                              {page.description ? (
                                <div style={{ marginTop: '0.2rem', opacity: 0.8 }}>
                                  {page.description}
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : null}

                    <div
                      style={{
                        position: 'absolute',
                        top: '0.38rem',
                        right: 0,
                        display: 'flex',
                        gap: '0.3rem',
                        opacity: 0.58,
                      }}>
                      <button
                        type='button'
                        aria-label='Copy answer'
                        title='Copy answer'
                        onClick={() => void copyAnswer(message.content)}
                        style={{
                          width: '1.7rem',
                          height: '1.7rem',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: 0,
                          fontSize: '0.78rem',
                          lineHeight: 1,
                          background: 'rgba(127, 127, 127, 0.05)',
                          border: '1px solid rgba(127, 127, 127, 0.2)',
                          borderRadius: '0.3rem',
                          color: 'inherit',
                        }}>
                        ⧉
                      </button>

                      {message.aliases?.length ? (
                        <button
                          type='button'
                          aria-label='File this answer'
                          title='File this answer'
                          disabled={busy}
                          onClick={() => void previewFiling(message)}
                          style={{
                            width: '1.7rem',
                            height: '1.7rem',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: 0,
                            fontSize: '0.78rem',
                            lineHeight: 1,
                            background: 'rgba(127, 127, 127, 0.05)',
                            border: '1px solid rgba(127, 127, 127, 0.2)',
                            borderRadius: '0.3rem',
                            color: 'inherit',
                          }}>
                          ↳
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {assistant && isFilingTarget && filing ? (
                  <div
                    style={{
                      marginTop: '0.8rem',
                      paddingTop: '0.8rem',
                      borderTop: '1px solid var(--bs-border-color, #ced4da)',
                    }}>
                    <strong>
                      {filing.committed
                        ? 'Filed'
                        : filing.noChange
                          ? 'Nothing to file'
                          : filing.previewToken
                            ? 'Filing preview'
                            : 'Filing result'}
                    </strong>

                    {filing.noChange ? (
                      <p style={{ margin: '0.4rem 0 0' }}>
                        {filing.answer ??
                          'This answer was left in chat because no durable wiki page was proposed.'}
                      </p>
                    ) : null}

                    {filedPages.length > 0 ? (
                      <ul>
                        {filedPages.map((page, index) => (
                          <li key={page.alias ?? `${page.title}-${index}`}>
                            {page.alias ? (
                              <a
                                href={`/n/${encodeURIComponent(page.alias)}`}
                                target='_blank'
                                rel='noreferrer'>
                                {page.alias}
                              </a>
                            ) : (
                              '(new page)'
                            )}{' '}
                            — {page.pageType} — {page.title}
                            {Array.isArray(page.sourceAliases)
                              ? ` — evidence: ${page.sourceAliases.length}`
                              : ''}
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {filing.previewToken ? (
                      <button
                        type='button'
                        disabled={!canCommit}
                        onClick={() => void commitFiling()}>
                        Commit filed page
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}

        {busy ? (
          <div
            role='status'
            aria-live='polite'
            aria-label='Thinking'
            style={{
              display: 'inline-flex',
              width: 'fit-content',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0.45rem 0.7rem',
              border: '1px solid rgba(118, 185, 0, 0.32)',
              borderRadius: '999px',
              background: 'rgba(248, 255, 238, 0.92)',
              animation: 'memexThinkingPulse 1.8s ease-in-out infinite',
              position: standalone ? 'fixed' : undefined,
              left: standalone ? '50%' : undefined,
              transform: standalone ? 'translateX(-50%)' : undefined,
              bottom: standalone ? '4.6rem' : undefined,
              zIndex: standalone ? 110 : undefined,
              boxShadow: standalone
                ? '0 3px 14px rgba(0, 0, 0, 0.08)'
                : undefined,
            }}>
            <span
              aria-hidden='true'
              style={{
                display: 'inline-flex',
                gap: '0.22rem',
                alignItems: 'center',
              }}>
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  style={{
                    width: '0.42rem',
                    height: '0.42rem',
                    borderRadius: '50%',
                    background: '#76b900',
                    display: 'inline-block',
                    animation: 'memexThinkingDot 1.1s ease-in-out infinite',
                    animationDelay: `${dot * 0.14}s`,
                  }}
                />
              ))}
            </span>
          </div>
        ) : null}

        <div ref={messagesEndRef} />
      </div>

      <div
        style={{
          position: 'fixed',
          left: '50%',
          bottom: '0.75rem',
          transform: 'translateX(-50%)',
          width: 'min(1160px, calc(100% - 2rem))',
          zIndex: 100,
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          border: '1px solid var(--bs-border-color, #ced4da)',
          borderRadius: '0.8rem',
          padding: '0.45rem 0.55rem',
          background: 'rgba(255, 255, 255, 0.9)',
          backdropFilter: 'blur(10px)',
          boxShadow: '0 4px 18px rgba(0, 0, 0, 0.08)',
        }}>
        {selectionContext ? (
          <div
            title={selectionContext}
            style={{
              flex: '0 1 auto',
              width: 'fit-content',
              minWidth: 0,
              maxWidth: 'min(42vw, 28rem)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              padding: '0.35rem 0.5rem',
              borderRadius: '0.55rem',
              background: 'rgba(127, 127, 127, 0.07)',
              border: '1px solid rgba(127, 127, 127, 0.14)',
              fontSize: '0.8rem',
              lineHeight: 1.2,
            }}>
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
              <strong>{selectionContext}</strong>
            </span>
            <button
              type='button'
              aria-label='Remove highlighted text'
              title='Remove highlighted text'
              onClick={() => setSelectionContext('')}
              style={{
                flex: '0 0 auto',
                border: 0,
                background: 'transparent',
                color: 'inherit',
                padding: 0,
                lineHeight: 1,
                opacity: 0.65,
              }}>
              ×
            </button>
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void ask()
            }
          }}
          rows={1}
          aria-label='Ask the wiki'
          placeholder={
            selectionContext
              ? 'Ask about the highlighted text… Enter to send'
              : 'Ask the wiki… Enter to send'
          }
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            height: '2.35rem',
            minHeight: '2.35rem',
            maxHeight: '2.35rem',
            resize: 'none',
            overflow: 'hidden',
            borderRadius: '0.65rem',
            padding: '0.48rem 0.75rem',
            boxSizing: 'border-box',
          }}
        />

        {!standalone ? (
          <select
            aria-label='Answer format'
            title='Answer format'
            value={format}
            onChange={(event) => setFormat(event.target.value as OutputFormat)}
            style={{
              flex: '0 0 auto',
              maxWidth: '9.5rem',
              height: '2.35rem',
              borderRadius: '0.55rem',
              padding: '0 0.45rem',
            }}>
            {FORMATS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </section>
  )
}
