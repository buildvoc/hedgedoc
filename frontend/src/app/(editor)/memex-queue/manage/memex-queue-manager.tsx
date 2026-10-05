'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'


const MAX_PENDING = 4
const HISTORY_LIMIT = 50
const PROCESS_POLL_MS = 3000
const PROCESS_TIMEOUT_MS = 45 * 60 * 1000

type QueueRow = {
  id?: string
  alias?: string
  source?: string
  noteAlias?: string
  sourceUpdatedAt?: string
  sourceRevision?: string
  queuedAt?: string
  processedAt?: string
  cancelledAt?: string
  completedAt?: string
  status?: string
  nodeBook?: string
  queueReason?: string
  ignoredReason?: string
}

type QueueHistoryResponse = {
  items?: QueueRow[]
  error?: string
}

type PendingResponse = {
  pending?: string[]
  error?: string
}

type ProcessResponse = {
  started?: boolean
  running?: boolean
  aliases?: string[]
  logTail?: string
  logBytes?: number
  error?: string
}

type QueueBatchResponse = {
  queued?: string[]
  skipped?: Array<{ alias: string; reason: string }>
  pending?: string[]
  error?: string
}

type TrailsResponse = {
  trails?: Array<{
    members?: Array<{ alias?: string }>
  }>
  error?: string
}

type ResetTrailsResponse = {
  ok?: boolean
  snapshot?: string
  error?: string
}

export interface QueueManagerSource {
  alias: string
  title: string
  summary: string
}

interface ModelSettingsStatus {
  provider?: string
  baseUrl?: string
  defaultModel?: string
}

interface Props {
  initialSources: QueueManagerSource[]
  sourceError: string
  modelSettings: ModelSettingsStatus
}

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

const aliasOf = (row: QueueRow): string =>
  [row.alias, row.source, row.noteAlias].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  )?.trim() ?? ''

const timestampOf = (row: QueueRow): string =>
  row.processedAt ?? row.cancelledAt ?? row.completedAt ?? row.queuedAt ?? ''

const prettyTime = (value?: string): string => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds))

const responseJson = async <T,>(response: Response): Promise<T> => {
  const text = await response.text()
  if (!text.trim()) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Expected JSON but received: ${text.slice(0, 180)}`)
  }
}

export const MemexQueueManager = ({
  initialSources,
  sourceError,
  modelSettings
}: Props) => {
  const [history, setHistory] = useState<QueueRow[]>([])
  const [pendingAliases, setPendingAliases] = useState<string[]>([])
  const [processRunning, setProcessRunning] = useState(false)
  const [processLog, setProcessLog] = useState('')
  const [processLogBytes, setProcessLogBytes] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set<string>())
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('Loading Memex queue status…')
  const [error, setError] = useState('')
  const stoppedRef = useRef(false)
  const terminalRef = useRef<HTMLPreElement | null>(null)

  const sourceByAlias = useMemo(
    () => new Map(initialSources.map((source) => [source.alias, source])),
    [initialSources]
  )
  const pendingSet = useMemo(() => new Set(pendingAliases), [pendingAliases])

  const latestHistoryByAlias = useMemo(() => {
    const latest = new Map<string, QueueRow>()
    for (const row of history) {
      const alias = aliasOf(row)
      if (alias && !latest.has(alias)) latest.set(alias, row)
    }
    return latest
  }, [history])

  const pendingRows = useMemo(
    () =>
      pendingAliases.map((alias) => ({
        alias,
        row: latestHistoryByAlias.get(alias),
        source: sourceByAlias.get(alias)
      })),
    [latestHistoryByAlias, pendingAliases, sourceByAlias]
  )

  const recentCounts = useMemo(() => {
    let processed = 0
    let cancelled = 0
    for (const row of history) {
      if (row.status === 'processed') processed += 1
      if (row.status === 'cancelled') cancelled += 1
    }
    return { processed, cancelled }
  }, [history])

  const fetchQueueHistory = useCallback(async (): Promise<QueueRow[]> => {
    const response = await fetch('/memex-queue?q=', { cache: 'no-store' })
    const data = await responseJson<QueueHistoryResponse>(response)
    if (!response.ok) {
      throw new Error(data.error || `Queue history HTTP ${response.status}`)
    }
    return Array.isArray(data.items) ? data.items : []
  }, [])

  const fetchPending = useCallback(async (): Promise<string[]> => {
    const response = await fetch('/memex-rerun-batch', { cache: 'no-store' })
    const data = await responseJson<PendingResponse>(response)
    if (!response.ok) {
      throw new Error(data.error || `Pending queue HTTP ${response.status}`)
    }
    return Array.isArray(data.pending) ? data.pending : []
  }, [])

  const fetchProcessStatus = useCallback(async (): Promise<ProcessResponse> => {
    const response = await fetch('/memex-process', { cache: 'no-store' })
    const data = await responseJson<ProcessResponse>(response)
    if (!response.ok) {
      throw new Error(data.error || `Process status HTTP ${response.status}`)
    }
    return data
  }, [])

  const refreshAll = useCallback(async () => {
    const [nextHistory, nextPending, processStatus] = await Promise.all([
      fetchQueueHistory(),
      fetchPending(),
      fetchProcessStatus()
    ])
    if (stoppedRef.current) return
    setHistory(nextHistory)
    setPendingAliases(nextPending)
    setProcessRunning(processStatus.running === true)
    setProcessLog(processStatus.logTail ?? '')
    setProcessLogBytes(processStatus.logBytes ?? 0)
  }, [fetchPending, fetchProcessStatus, fetchQueueHistory])

  useEffect(() => {
    stoppedRef.current = false

    const refresh = async () => {
      try {
        await refreshAll()
        if (!stoppedRef.current) {
          setError('')
          setStatus('Queue status refreshed.')
        }
      } catch (caught) {
        if (!stoppedRef.current) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      }
    }

    void refresh()
    const timer = window.setInterval(() => void refresh(), PROCESS_POLL_MS)

    return () => {
      stoppedRef.current = true
      window.clearInterval(timer)
    }
  }, [refreshAll])

  useEffect(() => {
    if (!processRunning || !terminalRef.current) return
    terminalRef.current.scrollTop = terminalRef.current.scrollHeight
  }, [processLog, processRunning])

  const removePending = async (alias: string) => {
    if (!window.confirm(`Remove ${sourceByAlias.get(alias)?.title ?? alias} from Pending?`)) {
      return
    }

    setBusy(true)
    setError('')
    setStatus(`Removing ${alias} from Pending…`)
    try {
      const response = await fetch('/memex-queue', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias })
      })
      const data = await responseJson<{ cancelled?: boolean; error?: string }>(response)
      if (!response.ok) {
        throw new Error(data.error || `Remove HTTP ${response.status}`)
      }
      await refreshAll()
      setStatus(data.cancelled ? `${alias} removed from Pending.` : `${alias} was not pending.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const processPending = async () => {
    setBusy(true)
    setError('')
    setStatus('Starting existing Process Pending runner…')
    try {
      const response = await fetch('/memex-process', {
        method: 'POST',
        cache: 'no-store'
      })
      const data = await responseJson<ProcessResponse>(response)
      if (!response.ok) {
        throw new Error(data.error || `Process Pending HTTP ${response.status}`)
      }
      await refreshAll()
      setStatus(
        data.started
          ? 'Process Pending started. Queue status will refresh automatically.'
          : 'Process Pending runner is already active.'
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const resetPending = async () => {
    if (
      !window.confirm(
        'Reset all currently pending sources for unchanged-revision reprocessing? Queue history is preserved.'
      )
    ) {
      return
    }

    setBusy(true)
    setError('')
    setStatus('Resetting Pending for reprocess…')
    try {
      const response = await fetch('/memex-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset-pending' })
      })
      const data = await responseJson<{ count?: number; error?: string }>(response)
      if (!response.ok) {
        throw new Error(data.error || `Reset Pending HTTP ${response.status}`)
      }
      await refreshAll()
      setStatus(`${data.count ?? 0} pending source(s) reset for reprocess.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const fetchTrailMemberAliases = async (): Promise<Set<string>> => {
    const response = await fetch('/memex-trails', { cache: 'no-store' })
    const data = await responseJson<TrailsResponse>(response)
    if (!response.ok) {
      throw new Error(data.error || `Memex trails HTTP ${response.status}`)
    }

    const aliases = new Set<string>()
    for (const trail of data.trails ?? []) {
      for (const member of trail.members ?? []) {
        if (typeof member.alias === 'string' && member.alias) {
          aliases.add(member.alias)
        }
      }
    }
    return aliases
  }

  const queueRerunBatch = async (aliases: string[]): Promise<QueueBatchResponse> => {
    const response = await fetch('/memex-rerun-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliases })
    })
    const data = await responseJson<QueueBatchResponse>(response)
    if (!response.ok) {
      throw new Error(data.error || `Rerun queue HTTP ${response.status}`)
    }
    return data
  }

  const requestScopedProcess = async (aliases: string[]) => {
    const response = await fetch('/memex-process', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliases })
    })
    const data = await responseJson<ProcessResponse>(response)
    if (!response.ok) {
      throw new Error(data.error || `Scoped Process Pending HTTP ${response.status}`)
    }
  }

  const waitForBatch = async (aliases: string[], batchNumber: number) => {
    const deadline = Date.now() + PROCESS_TIMEOUT_MS

    while (Date.now() < deadline) {
      const [pending, running] = await Promise.all([
        fetchPending(),
        fetchProcessStatus()
      ])
      const currentPending = new Set(pending)
      const stillPending = aliases.filter((alias) => currentPending.has(alias))
      setPendingAliases(pending)
      setProcessRunning(running.running === true)
      setProcessLog(running.logTail ?? '')
      setProcessLogBytes(running.logBytes ?? 0)

      if (stillPending.length === 0) return
      if (!running.running) {
        throw new Error(
          `Batch ${batchNumber} runner stopped with ${stillPending.length} selected source(s) still pending. Inspect /tmp/memex-process-queue.log before retrying.`
        )
      }

      setStatus(
        `Batch ${batchNumber}: ${stillPending.length}/${aliases.length} selected source(s) still pending; ${pending.length} pending globally.`
      )
      await sleep(PROCESS_POLL_MS)
    }

    throw new Error(`Batch ${batchNumber} did not finish within 45 minutes.`)
  }

  const processSelected = async () => {
    if (selected.size < 1 || busy) return

    setBusy(true)
    setError('')
    const requested: string[] = Array.from(selected as Set<string>)
    let completed = 0
    let batchNumber = 0

    try {
      const startingPending = new Set<string>(await fetchPending())
      const becamePending = requested.filter((alias) => startingPending.has(alias))
      if (becamePending.length > 0) {
        throw new Error(
          `${becamePending.length} selected source(s) are already pending. Refresh and select only available sources.`
        )
      }

      const allowedTrailAliases = await fetchTrailMemberAliases()
      const remaining: string[] = [...requested]

      while (remaining.length > 0) {
        const batch: string[] = remaining.splice(0, MAX_PENDING)
        batchNumber += 1
        setStatus(
          `Batch ${batchNumber}: queueing ${batch.length} selected source(s) (${completed}/${requested.length} completed)…`
        )

        const queued = await queueRerunBatch(batch)
        const queuedAliases = queued.queued ?? []
        if (queuedAliases.length !== batch.length) {
          const detail = (queued.skipped ?? [])
            .map((item) => `${item.alias}: ${item.reason}`)
            .join('; ')
          throw new Error(
            `Batch ${batchNumber} queued ${queuedAliases.length}/${batch.length} source(s).${detail ? ` ${detail}` : ''}`
          )
        }

        setPendingAliases(queued.pending ?? (await fetchPending()))
        setStatus(`Batch ${batchNumber}: scoped processing ${queuedAliases.length} source(s)…`)
        await requestScopedProcess(queuedAliases)
        await waitForBatch(queuedAliases, batchNumber)

        for (const alias of batch) allowedTrailAliases.add(alias)
        const currentTrailAliases = await fetchTrailMemberAliases()
        const leaked = Array.from(currentTrailAliases).filter(
          (alias) => !allowedTrailAliases.has(alias)
        )
        if (leaked.length > 0) {
          throw new Error(
            `Batch ${batchNumber} trail-scope verification failed: ${leaked.length} unselected source(s) appeared in trails (${leaked.slice(0, 4).join(', ')}${leaked.length > 4 ? ', …' : ''}).`
          )
        }

        completed += batch.length
        setSelected((current) => {
          const next = new Set<string>(current)
          for (const alias of batch) next.delete(alias)
          return next
        })
        await refreshAll()
      }

      setStatus(
        `Completed ${completed} selected source(s) in ${batchNumber} scoped batch(es), maximum ${MAX_PENDING} at a time.`
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setStatus(
        'Controlled rerun stopped. Completed batches remain processed; unprocessed selections remain selected.'
      )
    } finally {
      setBusy(false)
      try {
        await refreshAll()
      } catch {
        // Preserve the primary action result.
      }
    }
  }

  const resetTrails = async () => {
    const confirmation = window.prompt(
      'This creates the existing safety snapshot, then clears trail state while preserving sources, queue history, and canonical associations. Type RESET to continue.'
    )
    if (confirmation !== 'RESET') {
      setStatus('Trail reset cancelled.')
      return
    }

    setBusy(true)
    setError('')
    setStatus('Creating trail safety snapshot and resetting trail state…')
    try {
      const response = await fetch('/memex-reset-trails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'RESET' })
      })
      const data = await responseJson<ResetTrailsResponse>(response)
      if (!response.ok) {
        throw new Error(data.error || `Trail reset HTTP ${response.status}`)
      }
      setSelected(new Set<string>())
      setStatus(`Trail reset complete. Snapshot: ${data.snapshot ?? 'path not returned'}`)
      window.setTimeout(() => window.location.reload(), 1000)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const toggleSelected = (alias: string) => {
    setSelected((current) => {
      const next = new Set<string>(current)
      if (next.has(alias)) next.delete(alias)
      else next.add(alias)
      return next
    })
  }

  const availableSources = initialSources.filter((source) => !pendingSet.has(source.alias))

  return (
    <main style={{ margin: '0 auto', maxWidth: '1280px', padding: '24px', width: '100%' }}>
      <header style={{ marginBottom: '20px' }}>
        <h1 style={{ marginBottom: '8px' }}>Memex Queue Manager</h1>
        <p style={{ margin: 0 }}>
          Operational dashboard over the existing Memex queue, processor, controlled rerun, and trail-reset routes.
        </p>
        <nav
          aria-label='Memex queue manager navigation'
          style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginTop: '14px' }}
        >
          <Link href='/explore/my'>Add Sources</Link>
          <Link href='/explore/my?memex=pending'>Existing Pending View</Link>
          <Link href='/memex-index'>Memex Index</Link>
          <Link href='/memex-log'>Log</Link>
          <Link href='/memex-snapshots'>Snapshots</Link>
          <Link href='/memex-settings'>Model Settings</Link>
        </nav>
      </header>

      <section style={panelStyle}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 24px', alignItems: 'center' }}>
          <strong>Pending: {pendingAliases.length} / {MAX_PENDING}</strong>
          <strong>Processor: {processRunning ? 'Running' : 'Idle'}</strong>
          <span>Recent processed: {recentCounts.processed}</span>
          <span>Recent cancelled: {recentCounts.cancelled}</span>
          <span>
            Model: {modelSettings.provider || 'unknown'} · {modelSettings.defaultModel || 'not available'}
          </span>
        </div>
        {modelSettings.baseUrl ? (
          <div style={{ marginTop: '8px', opacity: 0.75 }}>
            Model endpoint: <code>{modelSettings.baseUrl}</code>
          </div>
        ) : null}
        <div style={{ marginTop: '10px' }} aria-live='polite'>
          {status}
        </div>
        {error ? (
          <div role='alert' style={{ marginTop: '8px', color: 'var(--bs-danger, #dc3545)' }}>
            {error}
          </div>
        ) : null}
      </section>

      <section style={panelStyle}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
          <h2 style={{ margin: '0 auto 0 0' }}>Pending Queue</h2>
          <button
            type='button'
            style={buttonStyle}
            disabled={busy || processRunning || pendingAliases.length === 0}
            onClick={() => void processPending()}
          >
            {processRunning ? 'Processing…' : 'Process Pending'}
          </button>
          <button
            type='button'
            style={buttonStyle}
            disabled={busy || pendingAliases.length === 0}
            onClick={() => void resetPending()}
          >
            Reset Pending for Reprocess
          </button>
          <Link href='/explore/my'>Add Sources</Link>
        </div>

        <div style={{ marginBottom: '14px' }}>
          <div style={{ marginBottom: '8px' }}>
            <strong>Process terminal</strong>
            <span style={{ marginLeft: '8px', opacity: 0.7 }}>
              {processRunning ? 'live' : 'last run'} · {processLogBytes.toLocaleString()} bytes
            </span>
          </div>
          <pre
            ref={terminalRef}
            style={{
              background: '#111',
              borderRadius: '6px',
              color: '#eee',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: '12px',
              lineHeight: 1.45,
              margin: '10px 0 0',
              maxHeight: '360px',
              minHeight: '120px',
              overflow: 'auto',
              padding: '12px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word'
            }}
          >
            {processLog || 'No processor output has been written yet.'}
          </pre>
        </div>

        {pendingRows.length === 0 ? (
          <p style={{ marginBottom: 0 }}>No sources are currently pending.</p>
        ) : (
          <div style={{ display: 'grid', gap: '8px' }}>
            {pendingRows.map(({ alias, row, source }) => (
              <article
                key={alias}
                style={{
                  border: '1px solid var(--bs-border-color, #dee2e6)',
                  borderRadius: '6px',
                  padding: '10px 12px'
                }}
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                  <Link href={`/n/${encodeURIComponent(alias)}`}>
                    <strong>{source?.title ?? alias}</strong>
                  </Link>
                  <code>{alias}</code>
                  {row?.queueReason ? <span>reason: {row.queueReason}</span> : null}
                  <span>queued: {prettyTime(row?.queuedAt)}</span>
                  {row?.sourceRevision ? <span>revision: {row.sourceRevision}</span> : null}
                  <button
                    type='button'
                    style={{ ...dangerButtonStyle, marginLeft: 'auto' }}
                    disabled={busy}
                    onClick={() => void removePending(alias)}
                  >
                    Remove from Queue
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section style={panelStyle}>
        <details>
          <summary style={{ cursor: 'pointer' }}>
            <strong>Recent Queue History ({Math.min(history.length, HISTORY_LIMIT)})</strong>
          </summary>
          <div style={{ overflowX: 'auto', marginTop: '12px' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '6px' }}>Status</th>
                  <th style={{ textAlign: 'left', padding: '6px' }}>Source</th>
                  <th style={{ textAlign: 'left', padding: '6px' }}>Reason</th>
                  <th style={{ textAlign: 'left', padding: '6px' }}>Time</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, HISTORY_LIMIT).map((row, index) => {
                  const alias = aliasOf(row)
                  const source = sourceByAlias.get(alias)
                  return (
                    <tr key={`${row.id ?? alias}-${index}`}>
                      <td style={{ padding: '6px', borderTop: '1px solid var(--bs-border-color, #dee2e6)' }}>
                        {row.status ?? 'unknown'}
                      </td>
                      <td style={{ padding: '6px', borderTop: '1px solid var(--bs-border-color, #dee2e6)' }}>
                        {alias ? (
                          <Link href={`/n/${encodeURIComponent(alias)}`}>
                            {source?.title ?? alias}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td style={{ padding: '6px', borderTop: '1px solid var(--bs-border-color, #dee2e6)' }}>
                        {row.queueReason ?? '—'}
                      </td>
                      <td style={{ padding: '6px', borderTop: '1px solid var(--bs-border-color, #dee2e6)' }}>
                        {prettyTime(timestampOf(row))}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section style={panelStyle}>
        <h2 style={{ marginTop: 0 }}>Controlled Rerun</h2>
        <p>
          Uses the existing <code>/memex-rerun-batch</code> and scoped <code>/memex-process</code> flow. Any number may be selected; processing runs in batches of up to {MAX_PENDING} and verifies trail scope after each batch.
        </p>
        {sourceError ? (
          <p role='alert' style={{ color: 'var(--bs-danger, #dc3545)' }}>
            Source catalogue unavailable: {sourceError}
          </p>
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
              <button
                type='button'
                style={buttonStyle}
                disabled={busy}
                onClick={() => setSelected(new Set<string>(availableSources.map((source) => source.alias)))}
              >
                Select all available
              </button>
              <button
                type='button'
                style={buttonStyle}
                disabled={busy || selected.size === 0}
                onClick={() => setSelected(new Set<string>())}
              >
                Clear
              </button>
              <button
                type='button'
                style={{ ...buttonStyle, fontWeight: 600 }}
                disabled={busy || selected.size === 0 || processRunning}
                onClick={() => void processSelected()}
              >
                Queue + process selected ({selected.size})
              </button>
            </div>

            <details>
              <summary style={{ cursor: 'pointer' }}>
                <strong>Indexed Sources ({initialSources.length})</strong> — {selected.size} selected
              </summary>
              <div style={{ display: 'grid', gap: '6px', marginTop: '10px', maxHeight: '480px', overflowY: 'auto' }}>
                {initialSources.map((source) => {
                  const isPending = pendingSet.has(source.alias)
                  return (
                    <label
                      key={source.alias}
                      style={{
                        alignItems: 'flex-start',
                        display: 'flex',
                        gap: '8px',
                        opacity: isPending ? 0.6 : 1
                      }}
                    >
                      <input
                        type='checkbox'
                        checked={selected.has(source.alias)}
                        disabled={busy || isPending}
                        onChange={() => toggleSelected(source.alias)}
                      />
                      <span>
                        <strong>{source.title}</strong>{' '}
                        <code>{source.alias}</code>
                        {isPending ? ' — already pending' : ''}
                        {source.summary ? <span> — {source.summary}</span> : null}
                      </span>
                    </label>
                  )
                })}
              </div>
            </details>
          </>
        )}
      </section>

      <section style={{ ...panelStyle, borderColor: 'var(--bs-danger, #dc3545)' }}>
        <h2 style={{ marginTop: 0 }}>Maintenance</h2>
        <p>
          Trail reset is intentionally separate from ordinary queue processing. It uses the existing route that creates a safety snapshot before clearing trail state and preserves source catalogue, queue history, and canonical associations.
        </p>
        <button
          type='button'
          style={{ ...dangerButtonStyle, fontWeight: 600 }}
          disabled={busy || processRunning}
          onClick={() => void resetTrails()}
        >
          Snapshot + reset all trails
        </button>
      </section>
    </main>
  )
}
