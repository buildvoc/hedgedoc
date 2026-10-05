'use client'

import { useMemo, useState } from 'react'

type WikiMutation = {
  alias: string
  pageType: string
  title: string
  description?: string
  created?: boolean
}

type ConversationResult = {
  committed: boolean
  dryRun: boolean
  answer: string
  count: number
  pages: WikiMutation[]
  indexAlias?: string
  model?: string
  provider?: string
  previewToken?: string
  previewExpiresAt?: string
}

type Props = {
  endpoint?: string
}

const sourceAliasPolicy = `
Source alias policy (mandatory):
- targetAliases may contain derived wiki aliases beginning with "memex-wiki-".
- sourceAliases must contain canonical raw HedgeDoc source aliases only.
- Never put any alias beginning with "memex-wiki-" in sourceAliases.
- For an existing derived page, preserve its current raw sourceAliases unless the supplied canonical evidence explicitly justifies a change.
- A source-summary/entity/topic/comparison/synthesis page is derived context, not canonical source evidence.
- If you cannot determine valid raw sourceAliases from the supplied page/evidence context, return no mutation rather than inventing an alias.
`.trim()

export const MemexWikiConversationPanel = ({
  endpoint = '/memex-wiki-conversation',
}: Props) => {
  const [conversation, setConversation] = useState('')
  const [aliasesText, setAliasesText] = useState('')
  const [preview, setPreview] = useState<ConversationResult | null>(null)
  const [result, setResult] = useState<ConversationResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const targetAliases = useMemo(
    () =>
      aliasesText
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    [aliasesText],
  )

  const callConversation = async (commit: boolean) => {
    const instruction = conversation.trim()
    if (!instruction) {
      setError('Enter a conversation instruction first.')
      return
    }

    if (commit && !preview?.previewToken) {
      setError('Preview is missing or expired. Generate a new preview first.')
      return
    }

    setBusy(true)
    setError('')

    try {
      const sendRequest = async (payload: Record<string, unknown>) => {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        })

        const body = await response.json().catch(() => null)
        return { response, body }
      }

      if (commit) {
        const attempt = await sendRequest({
          commit: true,
          previewToken: preview?.previewToken,
        })

        if (!attempt.response.ok) {
          throw new Error(
            attempt.body?.error ??
              `Memex conversation commit failed with HTTP ${attempt.response.status}`,
          )
        }

        setResult(attempt.body as ConversationResult)
        setPreview(null)
        return
      }

      const guardedInstruction = `${instruction}\n\n${sourceAliasPolicy}`
      const provenance = `conversation-ui-v5d ${new Date().toISOString()}`
      let attempt = await sendRequest({
        commit: false,
        provenance,
        targetAliases,
        conversation: guardedInstruction,
      })

      if (
        !attempt.response.ok &&
        typeof attempt.body?.error === 'string' &&
        (attempt.body.error.includes('unavailable sourceAliases') ||
          attempt.body.error.includes('derived wiki aliases as sourceAliases'))
      ) {
        attempt = await sendRequest({
          commit: false,
          provenance,
          targetAliases,
          conversation: `${guardedInstruction}\n\nThe previous attempt was rejected because it used an unavailable or derived wiki alias in sourceAliases. Correct that mistake. Preserve only canonical raw source aliases already supported by the target page evidence. Do not use any memex-wiki-* alias as source evidence.`,
        })
      }

      if (!attempt.response.ok) {
        throw new Error(
          attempt.body?.error ??
            `Memex conversation request failed with HTTP ${attempt.response.status}`,
        )
      }

      setPreview(attempt.body as ConversationResult)
      setResult(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const displayed = result ?? preview

  return (
    <section
      aria-label='Memex wiki conversation'
      style={{
        border: '1px solid var(--bs-border-color, #ced4da)',
        borderRadius: '0.5rem',
        padding: '1rem',
        marginTop: '1rem',
      }}>
      <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>
        Memex wiki conversation
      </h2>

      <label style={{ display: 'block', marginBottom: '0.35rem' }}>
        Instruction
      </label>
      <textarea
        value={conversation}
        onChange={(event) => {
          setConversation(event.target.value)
          setPreview(null)
          setResult(null)
          setError('')
        }}
        rows={5}
        placeholder='Ask Memex to clarify, revise or synthesize maintained wiki pages without inventing unsupported evidence.'
        style={{ width: '100%', marginBottom: '0.75rem' }}
      />

      <label style={{ display: 'block', marginBottom: '0.35rem' }}>
        Target aliases (optional, comma-separated)
      </label>
      <input
        value={aliasesText}
        onChange={(event) => {
          setAliasesText(event.target.value)
          setPreview(null)
          setResult(null)
          setError('')
        }}
        placeholder='memex-wiki-entity-inigo-triggs'
        style={{ width: '100%', marginBottom: '0.75rem' }}
      />

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button
          type='button'
          disabled={busy || !conversation.trim()}
          onClick={() => void callConversation(false)}>
          {busy ? 'Working…' : 'Preview changes'}
        </button>

        <button
          type='button'
          disabled={busy || !preview?.previewToken || preview.count < 1}
          onClick={() => void callConversation(true)}>
          Commit preview
        </button>
      </div>

      {error ? (
        <p role='alert' style={{ marginTop: '0.75rem' }}>
          {error}
        </p>
      ) : null}

      {displayed ? (
        <div style={{ marginTop: '1rem' }}>
          <strong>
            {displayed.committed ? 'Committed' : 'Preview'}: {displayed.count}{' '}
            page{displayed.count === 1 ? '' : 's'}
          </strong>
          <p>{displayed.answer}</p>

          {displayed.pages.length > 0 ? (
            <ul>
              {displayed.pages.map((page) => (
                <li key={page.alias}>
                  <code>{page.alias}</code> — {page.pageType} — {page.title}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
