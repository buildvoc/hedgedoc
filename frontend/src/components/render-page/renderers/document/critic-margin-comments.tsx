'use client'

/*
 * CRITIC_CONVERSATION_LAYOUT_V3
 * Conversation-oriented CriticMarkup rail:
 * - one card per thread
 * - wider rail
 * - clear user / assistant message bubbles
 * - one rail scrollbar, no nested message scrollbar
 */
import type { RefObject } from 'react'
import React, { useCallback, useEffect, useState } from 'react'

interface CriticMessage {
  author: string
  text: string
}

interface MarginThread {
  raw: string
  messages: CriticMessage[]
  ordinal: number
  anchorTop: number
}

export interface CriticMarginCommentsProps {
  containerRef: RefObject<HTMLDivElement>
  refreshKey: string
}

const postAction = (action: 'reply' | 'resolve', thread: MarginThread, text = ''): void => {
  window.parent.postMessage(
    {
      type: 'specdoc-critic-action',
      action,
      raw: thread.raw,
      ordinal: thread.ordinal,
      text
    },
    '*'
  )
}

const messageClass = (author: string): string => {
  const normalized = author.trim().toLowerCase()
  if (normalized === 'hp') return 'critic-margin-message-user'
  if (normalized === 'memex') return 'critic-margin-message-assistant'
  return 'critic-margin-message-other'
}

const ThreadCard: React.FC<{ thread: MarginThread }> = ({ thread }) => {
  const [reply, setReply] = useState('')

  const sendReply = useCallback(() => {
    const value = reply.trim()
    if (!value) return
    postAction('reply', thread, value)
    setReply('')
  }, [reply, thread])

  return (
    <aside className={'critic-margin-comment'}>
      <header className={'critic-margin-thread-header'}>
        <div>
          <strong>Conversation</strong>
          <span className={'critic-margin-thread-count'}>
            {thread.messages.length} message{thread.messages.length === 1 ? '' : 's'}
          </span>
        </div>

        <button
          type={'button'}
          className={'critic-margin-resolve'}
          onClick={() => postAction('resolve', thread)}>
          Resolve
        </button>
      </header>

      <div className={'critic-margin-messages'}>
        {thread.messages.map((message, index) => (
          <article
            className={`critic-margin-message ${messageClass(message.author)}`}
            key={index}>
            <div className={'critic-margin-message-head'}>
              <strong>@{message.author || 'reply'}</strong>
            </div>
            <div className={'critic-margin-text'}>{message.text}</div>
          </article>
        ))}
      </div>

      <footer className={'critic-margin-reply'}>
        <textarea
          value={reply}
          rows={2}
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              sendReply()
            }
          }}
          placeholder={'Reply to this conversation…'}
          aria-label={'Reply to review thread'}
        />
        <button type={'button'} onClick={sendReply}>
          Reply
        </button>
      </footer>
    </aside>
  )
}

export const CriticMarginComments: React.FC<CriticMarginCommentsProps> = ({ containerRef, refreshKey }) => {
  const [threads, setThreads] = useState<MarginThread[]>([])
  const [railLeft, setRailLeft] = useState(0)

  const measure = useCallback(() => {
    const container = containerRef.current
    if (!container) {
      setThreads([])
      return
    }

    const anchors = Array.from(container.querySelectorAll<HTMLElement>('.critic-comment[data-critic-raw]'))
    const containerRect = container.getBoundingClientRect()
    const viewportWidth = document.documentElement.clientWidth
    const railWidth = 420
    const gap = 18
    const canUseMargin = viewportWidth - containerRect.right >= railWidth + gap + 8

    setRailLeft(
      canUseMargin
        ? container.clientWidth + gap
        : Math.max(8, container.clientWidth - railWidth - 8)
    )

    const counts = new Map<string, number>()
    const next: MarginThread[] = []

    for (const anchor of anchors) {
      const raw = anchor.dataset.criticRaw || ''
      if (!raw || anchor.dataset.criticResolved === '1') continue

      let messages: CriticMessage[] = []
      try {
        const parsed = JSON.parse(anchor.dataset.criticMessages || '[]')
        if (Array.isArray(parsed)) {
          messages = parsed
            .map((message) => ({
              author: String(message?.author || ''),
              text: String(message?.text || '')
            }))
            .filter((message) => message.text)
        }
      } catch {
        messages = []
      }

      if (!messages.length) continue

      const ordinal = counts.get(raw) || 0
      counts.set(raw, ordinal + 1)

      const rect = anchor.getBoundingClientRect()
      next.push({
        raw,
        messages,
        ordinal,
        anchorTop: rect.top - containerRect.top
      })
    }

    next.sort((a, b) => a.anchorTop - b.anchorTop)
    setThreads(next)
  }, [containerRef])

  useEffect(() => {
    const frame = window.requestAnimationFrame(measure)
    const onResize = () => measure()
    window.addEventListener('resize', onResize)

    const container = containerRef.current
    const observer =
      container && 'ResizeObserver' in window
        ? new ResizeObserver(() => measure())
        : null

    if (container && observer) observer.observe(container)

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
      observer?.disconnect()
    }
  }, [containerRef, measure, refreshKey])

  if (!threads.length) return null

  return (
    <div className={'critic-margin-layer'}>
      <div className={'critic-margin-rail-shell'} style={{ left: railLeft }}>
        <div className={'critic-margin-rail'}>
          {threads.map((thread, index) => (
            <ThreadCard
              key={`${thread.raw}:${thread.ordinal}:${index}`}
              thread={thread}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
