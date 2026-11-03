'use client'

import { MemexOkfTopicEntitySection } from '../../../components/memex/memex-okf-topic-entity-section'
import Link from 'next/link'
import { useRef, useState } from 'react'

const panelStyle = {
  border: '1px solid var(--bs-border-color, #dee2e6)',
  borderRadius: '8px',
  marginBottom: '16px',
  padding: '16px'
} as const

const buttonStyle = {
  background: 'var(--bs-body-bg, #fff)',
  border: '1px solid var(--bs-border-color, #ced4da)',
  borderRadius: '6px',
  color: 'var(--bs-body-color, #212529)',
  cursor: 'pointer',
  padding: '7px 11px'
} as const

const dangerButtonStyle = {
  ...buttonStyle,
  borderColor: 'var(--bs-danger, #dc3545)'
} as const

export default function MemexTrailRefreshPage() {
  const [running, setRunning] = useState(false)
  const [mode, setMode] = useState<'preview' | 'apply' | ''>('')
  const [log, setLog] = useState('')
  const [previewHash, setPreviewHash] = useState('')
  const [trailCount, setTrailCount] = useState(0)
  const [coverage, setCoverage] = useState(0)
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const terminalRef = useRef<HTMLPreElement | null>(null)

  const run = async (action: 'preview' | 'apply') => {
    if (running) return

    if (action === 'apply') {
      if (!previewHash) {
        setError('Generate a preview first.')
        return
      }
      if (confirmation !== 'APPLY') {
        setError('Type APPLY to confirm trail replacement.')
        return
      }
    }

    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    setMode(action)
    setLog('')
    setError('')

    let fullLog = ''

    try {
      const response = await fetch('/memex-trail-refresh-api', {
        method: 'POST',
        cache: 'no-store',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          previewHash: action === 'apply' ? previewHash : undefined,
          confirmation: action === 'apply' ? confirmation : undefined
        })
      })

      if (!response.ok || !response.body) {
        const detail = await response.text()
        throw new Error(detail || `Trail refresh HTTP ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue

        const chunk = decoder.decode(value, { stream: true })
        fullLog += chunk
        setLog((current) => current + chunk)
        window.requestAnimationFrame(() => {
          if (terminalRef.current) {
            terminalRef.current.scrollTop = terminalRef.current.scrollHeight
          }
        })
      }

      const tail = decoder.decode()
      if (tail) {
        fullLog += tail
        setLog((current) => current + tail)
      }

      const fatal = fullLog.match(/^FATAL:\s*(.+)$/m)?.[1]
      if (fatal) {
        setError(fatal)
        return
      }

      if (action === 'preview') {
        const hash =
          fullLog.match(/^PREVIEW_HASH:\s*([0-9a-f]{64})$/m)?.[1] ?? ''
        const nextTrailCount = Number(
          fullLog.match(/^TRAIL_COUNT:\s*(\d+)$/m)?.[1] ?? '0'
        )
        const nextCoverage = Number(
          fullLog.match(/^SOURCE_COVERAGE:\s*(\d+)$/m)?.[1] ?? '0'
        )

        if (!hash) {
          throw new Error('Preview completed without a preview hash.')
        }

        setPreviewHash(hash)
        setTrailCount(nextTrailCount)
        setCoverage(nextCoverage)
        setConfirmation('')
      } else if (/^APPLY COMPLETE$/m.test(fullLog)) {
        setPreviewHash('')
        setConfirmation('')
      }
    } catch (caught) {
      if (controller.signal.aborted && action === 'preview') {
        setLog((current) =>
          `${current}${current.endsWith('\n') || !current ? '' : '\n'}PREVIEW STOPPED BY USER\n`
        )
      } else {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      abortRef.current = null
      setRunning(false)
      setMode('')
    }
  }

  return (
    <main style={{ margin: '0 auto', maxWidth: '1100px', padding: '24px', width: '100%' }}>
      <header style={{ marginBottom: '20px' }}>
        <h1 style={{ marginBottom: '8px' }}>Memex Trail refresh</h1>
        <p style={{ margin: 0 }}>
          Regenerate system trails from the current Memex source catalogue with the configured LLM.
        </p>
        <nav style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginTop: '14px' }}>
          <Link href='/memex-index'>Memex Index</Link>
          <Link href='/memex-queue/manage'>Queue manager</Link>
        </nav>
      </header>

      <section style={panelStyle}>
        <h2 style={{ marginTop: 0 }}>Objective</h2>
        <p style={{ marginBottom: 0 }}>
          Preview reviews every indexed source sequentially, one source content per LLM
          call, and persists progress so an interrupted run can resume. After all sources
          are reviewed it consolidates candidate trails and stores the exact proposal.
          Apply requires the preview hash and confirmation, snapshots current local and
          HedgeDoc index state, then replaces only the <code>## Trails</code> section.
          Sources and user-created trails are untouched.
        </p>
      </section>

      <section style={panelStyle}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
          <button
            type='button'
            style={{ ...buttonStyle, fontWeight: 600 }}
            disabled={running}
            onClick={() => void run('preview')}
          >
            {running && mode === 'preview' ? 'Reviewing sources…' : 'Generate sequential preview'}
          </button>

          <button
            type='button'
            style={dangerButtonStyle}
            disabled={
              running ||
              !previewHash ||
              confirmation !== 'APPLY'
            }
            onClick={() => void run('apply')}
          >
            {running && mode === 'apply' ? 'Applying…' : 'Apply trail refresh'}
          </button>

          <button
            type='button'
            style={buttonStyle}
            disabled={!running || mode !== 'preview'}
            onClick={() => abortRef.current?.abort()}
          >
            Stop preview
          </button>
        </div>

        <div
          style={{
            alignItems: 'center',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            marginTop: '12px'
          }}
        >
          <label htmlFor='trail-refresh-confirmation'>Confirmation</label>
          <input
            id='trail-refresh-confirmation'
            value={confirmation}
            disabled={running || !previewHash}
            placeholder='Type APPLY'
            onChange={(event) => setConfirmation(event.target.value)}
            style={{ minWidth: '180px', padding: '6px 8px' }}
          />
          <span style={{ opacity: 0.75 }}>
            {previewHash
              ? `${trailCount} trails · ${coverage} unique source members`
              : 'Generate preview before apply'}
          </span>
        </div>

        {error ? (
          <p role='alert' style={{ color: 'var(--bs-danger, #dc3545)' }}>
            {error}
          </p>
        ) : null}

        <div style={{ margin: '14px 0 8px' }}>
          <strong>Trail refresh terminal</strong>
          <span style={{ marginLeft: '8px', opacity: 0.7 }}>
            {running ? mode : 'idle'}
          </span>
        </div>

        <pre
          ref={terminalRef}
          aria-live='polite'
          style={{
            background: '#111',
            borderRadius: '6px',
            color: '#eee',
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: '12px',
            lineHeight: 1.45,
            margin: 0,
            maxHeight: '560px',
            minHeight: '220px',
            overflow: 'auto',
            padding: '12px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {log || 'No sequential trail preview has been generated yet.'}
        </pre>
      </section>
          {/* MEMEX_OKF_TOPIC_ENTITY_SECTION */}
      <MemexOkfTopicEntitySection />
    </main>
  )
}
