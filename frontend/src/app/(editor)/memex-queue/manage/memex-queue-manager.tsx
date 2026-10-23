'use client'

import Link from 'next/link'
import type { MemexProcessProgress } from '../../../memex-process/process-progress'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'


const SCOPED_RERUN_BATCH_SIZE = 4
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
  serverNow?: string
  serverTimeZone?: string
  progress?: MemexProcessProgress | null
  error?: string
}

type DoclingBatchResponse = {
  started?: boolean
  running?: boolean
  inputCount?: number
  convertedCount?: number
  remainingCount?: number
  currentFile?: string
  logTail?: string
  logBytes?: number
  logPath?: string | null
  error?: string
}

type DoclingIngestItem = {
  file: string
  alias: string
  title: string
  ingestedAt?: string
  queuedAt?: string
}

type DoclingIngestResponse = {
  started?: boolean
  running?: boolean
  readyCount?: number
  ingestedCount?: number
  queuedCount?: number
  remainingCount?: number
  items?: DoclingIngestItem[]
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

const systemTimeLabel = (value: string | number, timeZone?: string): string => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, { timeZone: timeZone || undefined })
}

const durationLabel = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const rounded = Math.max(0, Math.round(seconds))
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const remainder = rounded % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${remainder}s`
  return `${remainder}s`
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
  const [processProgress, setProcessProgress] = useState<MemexProcessProgress | null>(null)
  const [clockNowMs, setClockNowMs] = useState<number | null>(null)
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState(0)
  const [serverTimeZone, setServerTimeZone] = useState<string | undefined>(undefined)
  const [doclingBatch, setDoclingBatch] = useState<DoclingBatchResponse>({})
  const [doclingIngest, setDoclingIngest] = useState<DoclingIngestResponse>({})
  const [selected, setSelected] = useState<Set<string>>(new Set<string>())
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('Loading Memex queue status…')
  const [error, setError] = useState('')
  const [auditRunning, setAuditRunning] = useState(false)
  const [auditLog, setAuditLog] = useState('')
  const auditAbortRef = useRef<AbortController | null>(null)
  const [cleanupRunning, setCleanupRunning] = useState(false)
  const [cleanupMode, setCleanupMode] = useState<'preview' | 'apply' | ''>('')
  const [cleanupLog, setCleanupLog] = useState('')
  const [cleanupPreviewHash, setCleanupPreviewHash] = useState('')
  const [cleanupPlanCount, setCleanupPlanCount] = useState(0)
  const [cleanupConfirmation, setCleanupConfirmation] = useState('')
  const cleanupAbortRef = useRef<AbortController | null>(null)
  const cleanupTerminalRef = useRef<HTMLPreElement | null>(null)
  const stoppedRef = useRef(false)
  const terminalRef = useRef<HTMLPreElement | null>(null)
  const doclingTerminalRef = useRef<HTMLPreElement | null>(null)
  const ingestTerminalRef = useRef<HTMLPreElement | null>(null)

  const sourceByAlias = useMemo(
    () => new Map(initialSources.map((source) => [source.alias, source])),
    [initialSources]
  )
  const pendingSet = useMemo(() => new Set(pendingAliases), [pendingAliases])
  const ingestedItems = useMemo(() => doclingIngest.items ?? [], [doclingIngest.items])
  const ingestedByAlias = useMemo(
    () => new Map(ingestedItems.map((item) => [item.alias, item])),
    [ingestedItems]
  )
  const unqueuedIngested = useMemo(
    () => ingestedItems.filter((item) => !item.queuedAt && !pendingSet.has(item.alias)),
    [ingestedItems, pendingSet]
  )

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

  const clockMs = clockNowMs === null ? null : clockNowMs + serverClockOffsetMs
  const runMetricsByAlias = useMemo(
    () => new Map(processProgress?.completedItems?.map((item) => [item.alias, item] as const) ?? []),
    [processProgress]
  )
  const completionMs = processProgress?.estimatedCompletionAt
    ? Date.parse(processProgress.estimatedCompletionAt) : Number.NaN
  const etaSeconds = processRunning && clockMs !== null && Number.isFinite(completionMs)
    ? Math.max(0, Math.ceil((completionMs - clockMs) / 1000)) : null

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

  const fetchDoclingBatchStatus = useCallback(async (): Promise<DoclingBatchResponse> => {
    const response = await fetch('/memex-docling-batch', { cache: 'no-store' })
    const data = await responseJson<DoclingBatchResponse>(response)
    if (!response.ok) {
      throw new Error(data.error || `Docling batch status HTTP ${response.status}`)
    }
    return data
  }, [])

  const fetchDoclingIngestStatus = useCallback(async (): Promise<DoclingIngestResponse> => {
    const response = await fetch('/memex-docling-ingest', { cache: 'no-store' })
    const data = await responseJson<DoclingIngestResponse>(response)
    if (!response.ok) {
      throw new Error(data.error || `HedgeDoc ingest status HTTP ${response.status}`)
    }
    return data
  }, [])

  const refreshAll = useCallback(async () => {
    const [nextHistory, nextPending, processStatus, nextDoclingBatch, nextDoclingIngest] =
      await Promise.all([
        fetchQueueHistory(),
        fetchPending(),
        fetchProcessStatus(),
        fetchDoclingBatchStatus(),
        fetchDoclingIngestStatus()
      ])
    if (stoppedRef.current) return
    setHistory(nextHistory)
    setPendingAliases(nextPending)
    setProcessRunning(processStatus.running === true)
    setProcessLog(processStatus.logTail ?? '')
    setProcessLogBytes(processStatus.logBytes ?? 0)
    setProcessProgress(processStatus.progress ?? null)
    setServerTimeZone(processStatus.serverTimeZone)
    if (processStatus.serverNow) {
      const serverMs = Date.parse(processStatus.serverNow)
      if (Number.isFinite(serverMs)) setServerClockOffsetMs(serverMs - Date.now())
    }
    setDoclingBatch(nextDoclingBatch)
    setDoclingIngest(nextDoclingIngest)
  }, [
    fetchDoclingBatchStatus,
    fetchDoclingIngestStatus,
    fetchPending,
    fetchProcessStatus,
    fetchQueueHistory
  ])

  useEffect(() => {
    setClockNowMs(Date.now())
    const timer = window.setInterval(() => setClockNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

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

  useEffect(() => {
    if (!doclingBatch.running || !doclingTerminalRef.current) return
    doclingTerminalRef.current.scrollTop = doclingTerminalRef.current.scrollHeight
  }, [doclingBatch.logTail, doclingBatch.running])

  useEffect(() => {
    if (!doclingIngest.running || !ingestTerminalRef.current) return
    ingestTerminalRef.current.scrollTop = ingestTerminalRef.current.scrollHeight
  }, [doclingIngest.logTail, doclingIngest.running])

  useEffect(() => {
    if (!cleanupTerminalRef.current) return
    cleanupTerminalRef.current.scrollTop =
      cleanupTerminalRef.current.scrollHeight
  }, [cleanupLog])

  const runSourceSummaryAudit = async () => {
    const controller = new AbortController()
    auditAbortRef.current = controller
    setAuditRunning(true)
    setAuditLog('')
    setError('')
    setStatus('Running read-only source-summary identity audit…')

    try {
      const response = await fetch('/memex-source-summary-audit', {
        cache: 'no-store',
        signal: controller.signal
      })

      if (!response.ok || !response.body) {
        const detail = await response.text()
        throw new Error(detail || `Audit HTTP ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          setAuditLog(
            (current) => current + decoder.decode(value, { stream: true })
          )
        }
      }

      const tail = decoder.decode()
      if (tail) setAuditLog((current) => current + tail)
      setStatus('Source-summary identity audit complete.')
    } catch (error) {
      if (controller.signal.aborted) {
        setAuditLog(
          (current) =>
            current +
            (current.endsWith('\n') || !current ? '' : '\n') +
            'AUDIT STOPPED BY USER\n'
        )
        setStatus('Source-summary identity audit stopped.')
      } else {
        const message =
          error instanceof Error ? error.message : String(error)
        setAuditLog(
          (current) =>
            current +
            (current.endsWith('\n') || !current ? '' : '\n') +
            `ERROR: ${message}\n`
        )
        setError(message)
      }
    } finally {
      auditAbortRef.current = null
      setAuditRunning(false)
    }
  }

  const runSourceSummaryCleanup = async (
    action: 'preview' | 'apply'
  ) => {
    if (cleanupRunning) return

    if (action === 'apply') {
      if (!cleanupPreviewHash) {
        setError('Run Preview cleanup before Apply cleanup.')
        return
      }

      if (cleanupConfirmation !== 'APPLY') {
        setError('Type APPLY to confirm source-summary cleanup.')
        return
      }
    }

    const controller = new AbortController()
    cleanupAbortRef.current = controller
    setCleanupRunning(true)
    setCleanupMode(action)
    setCleanupLog('')
    setError('')
    setStatus(
      action === 'preview'
        ? 'Building read-only source-summary cleanup preview…'
        : 'Applying deterministic source-summary cleanup…'
    )

    let fullLog = ''

    try {
      const response = await fetch('/memex-source-summary-cleanup', {
        method: 'POST',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action,
          previewHash: action === 'apply' ? cleanupPreviewHash : undefined,
          confirmation: action === 'apply' ? cleanupConfirmation : undefined
        })
      })

      if (!response.ok || !response.body) {
        const detail = await response.text()
        throw new Error(detail || `Cleanup HTTP ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue

        const chunk = decoder.decode(value, { stream: true })
        fullLog += chunk
        setCleanupLog((current) => current + chunk)
      }

      const tail = decoder.decode()
      if (tail) {
        fullLog += tail
        setCleanupLog((current) => current + tail)
      }

      if (/^FATAL:/m.test(fullLog)) {
        const fatal =
          fullLog.match(/^FATAL:\s*(.+)$/m)?.[1] ??
          'Source-summary cleanup failed.'
        setError(fatal)
        setStatus('Source-summary cleanup failed.')
        return
      }

      if (action === 'preview') {
        const previewHash =
          fullLog.match(/^PREVIEW_HASH:\s*([0-9a-f]{64})$/m)?.[1] ?? ''
        const safeCount = Number(
          fullLog.match(/^SAFE_PLAN_COUNT:\s*(\d+)$/m)?.[1] ?? '0'
        )

        setCleanupPreviewHash(previewHash)
        setCleanupPlanCount(safeCount)
        setCleanupConfirmation('')
        setStatus(
          `Source-summary cleanup preview complete: ${safeCount} safe migrations.`
        )
      } else if (/^APPLY COMPLETE$/m.test(fullLog)) {
        setCleanupPreviewHash('')
        setCleanupPlanCount(0)
        setCleanupConfirmation('')
        setStatus('Source-summary cleanup apply complete.')
      }
    } catch (error) {
      if (controller.signal.aborted && action === 'preview') {
        setCleanupLog(
          (current) =>
            current +
            (current.endsWith('\n') || !current ? '' : '\n') +
            'PREVIEW STOPPED BY USER\n'
        )
        setStatus('Source-summary cleanup preview stopped.')
      } else {
        const message =
          error instanceof Error ? error.message : String(error)
        setCleanupLog(
          (current) =>
            current +
            (current.endsWith('\n') || !current ? '' : '\n') +
            `CLIENT ERROR: ${message}\n`
        )
        setError(message)
      }
    } finally {
      cleanupAbortRef.current = null
      setCleanupRunning(false)
      setCleanupMode('')
    }
  }

  const removePending = async (alias: string) => {
    if (!window.confirm(`Remove ${sourceByAlias.get(alias)?.title ?? ingestedByAlias.get(alias)?.title ?? alias} from Pending?`)) {
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

  const controlDoclingBatch = async (action: 'start' | 'stop') => {
    setBusy(true)
    setError('')
    setStatus(`${action === 'start' ? 'Starting' : 'Stopping'} Docling batch…`)
    try {
      const response = await fetch('/memex-docling-batch', {
        method: action === 'start' ? 'POST' : 'DELETE',
        cache: 'no-store'
      })
      const data = await responseJson<DoclingBatchResponse>(response)
      if (!response.ok) {
        throw new Error(data.error || `Docling batch HTTP ${response.status}`)
      }
      await refreshAll()
      setStatus(action === 'start' ? 'Docling batch started/resumed.' : 'Docling batch stop requested.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const controlDoclingIngest = async (action: 'start' | 'stop') => {
    setBusy(true)
    setError('')
    setStatus(`${action === 'start' ? 'Starting' : 'Stopping'} HedgeDoc batch ingestion…`)
    try {
      const response = await fetch('/memex-docling-ingest', {
        method: action === 'start' ? 'POST' : 'DELETE',
        cache: 'no-store'
      })
      const data = await responseJson<DoclingIngestResponse>(response)
      if (!response.ok) {
        throw new Error(data.error || `HedgeDoc ingest HTTP ${response.status}`)
      }
      await refreshAll()
      setStatus(
        action === 'start'
          ? 'HedgeDoc batch ingestion started/resumed.'
          : 'HedgeDoc batch ingestion stop requested.'
      )
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
        const batch: string[] = remaining.splice(0, SCOPED_RERUN_BATCH_SIZE)
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
        `Completed ${completed} selected source(s) in ${batchNumber} scoped batch(es), maximum ${SCOPED_RERUN_BATCH_SIZE} at a time.`
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
          Operational dashboard over Docling/HedgeDoc batch ingestion, the Memex queue, processor, controlled rerun, and trail-reset routes.
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
          <strong>Pending: {pendingAliases.length} (no limit)</strong>
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
        <h2 style={{ marginTop: 0 }}>Docling → HedgeDoc Batch Ingestion</h2>
        <p>
          Fixed pipeline stages: PDF batch conversion → DoclingDocument JSON → HedgeDoc notes → Pending queue → existing Process Pending runner. The terminal panes are read-only logs; no arbitrary shell is exposed.
        </p>

        <div style={{ display: 'grid', gap: '16px', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))' }}>
          <article style={{ border: '1px solid var(--bs-border-color, #dee2e6)', borderRadius: '6px', padding: '12px' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
              <h3 style={{ margin: '0 auto 0 0' }}>1. Docling batch</h3>
              <strong>{doclingBatch.running ? 'Running' : 'Idle'}</strong>
              <button
                type='button'
                style={buttonStyle}
                disabled={busy || processRunning || doclingBatch.running || doclingIngest.running}
                onClick={() => void controlDoclingBatch('start')}
              >
                Start / Resume
              </button>
              <button
                type='button'
                style={dangerButtonStyle}
                disabled={busy || !doclingBatch.running}
                onClick={() => void controlDoclingBatch('stop')}
              >
                Stop
              </button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', marginTop: '8px' }}>
              <span>PDFs: {doclingBatch.inputCount ?? 0}</span>
              <span>JSON ready: {doclingBatch.convertedCount ?? 0}</span>
              <span>Remaining: {doclingBatch.remainingCount ?? 0}</span>
            </div>
            {doclingBatch.currentFile ? (
              <div style={{ marginTop: '6px' }}>
                Current: <code>{doclingBatch.currentFile}</code>
              </div>
            ) : null}
            <pre
              ref={doclingTerminalRef}
              style={{
                background: '#111',
                borderRadius: '6px',
                color: '#eee',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                fontSize: '12px',
                lineHeight: 1.45,
                margin: '10px 0 0',
                maxHeight: '280px',
                minHeight: '120px',
                overflow: 'auto',
                padding: '12px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}
            >
              {doclingBatch.logTail || 'No Docling batch output has been written yet.'}
            </pre>
          </article>

          <article style={{ border: '1px solid var(--bs-border-color, #dee2e6)', borderRadius: '6px', padding: '12px' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
              <h3 style={{ margin: '0 auto 0 0' }}>2. HedgeDoc ingestion</h3>
              <strong>{doclingIngest.running ? 'Running' : 'Idle'}</strong>
              <button
                type='button'
                style={buttonStyle}
                disabled={busy || processRunning || doclingIngest.running || doclingBatch.running || (doclingIngest.readyCount ?? 0) === 0}
                onClick={() => void controlDoclingIngest('start')}
              >
                Start / Resume
              </button>
              <button
                type='button'
                style={dangerButtonStyle}
                disabled={busy || !doclingIngest.running}
                onClick={() => void controlDoclingIngest('stop')}
              >
                Stop
              </button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', marginTop: '8px' }}>
              <span>JSON ready: {doclingIngest.readyCount ?? 0}</span>
              <span>Ingested: {doclingIngest.ingestedCount ?? 0}</span>
              <span>Queued: {doclingIngest.queuedCount ?? 0}</span>
              <span>Remaining: {doclingIngest.remainingCount ?? 0}</span>
            </div>
            <p style={{ marginBottom: '8px' }}>
              New notes use the existing default document frontmatter shape, with the JSON filename stem substituted for <code>Untitled</code>, then store the compact DoclingDocument JSON below the heading.
            </p>
            <pre
              ref={ingestTerminalRef}
              style={{
                background: '#111',
                borderRadius: '6px',
                color: '#eee',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                fontSize: '12px',
                lineHeight: 1.45,
                margin: '10px 0 0',
                maxHeight: '280px',
                minHeight: '120px',
                overflow: 'auto',
                padding: '12px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}
            >
              {doclingIngest.logTail || 'No HedgeDoc ingestion output has been written yet.'}
            </pre>
          </article>
        </div>

        <div style={{ marginTop: '14px', display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
          <strong>3. Automatic Pending queue</strong>
          <span>
            All successfully ingested notes are added to Pending automatically, without a four-source limit.
            {unqueuedIngested.length > 0
              ? ` ${unqueuedIngested.length} previously ingested note(s) await ingestion resume/backfill.`
              : ' All ingested notes have queue records.'}
          </span>
        </div>

        {ingestedItems.length > 0 ? (
          <details style={{ marginTop: '12px' }}>
            <summary style={{ cursor: 'pointer' }}>
              <strong>Ingested HedgeDoc notes ({ingestedItems.length})</strong>
            </summary>
            <div style={{ display: 'grid', gap: '6px', marginTop: '8px', maxHeight: '280px', overflowY: 'auto' }}>
              {ingestedItems.map((item) => (
                <div key={item.file}>
                  <Link href={`/n/${encodeURIComponent(item.alias)}`}>
                    <strong>{item.title}</strong>
                  </Link>{' '}
                  <code>{item.alias}</code>
                  {item.queuedAt ? ' — queued' : ' — ready for Pending'}
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </section>

      <section style={panelStyle}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
          <h2 style={{ margin: '0 auto 0 0' }}>4. Pending Queue / Process</h2>
          <button
            type='button'
            style={buttonStyle}
            disabled={busy || processRunning || doclingBatch.running || doclingIngest.running || pendingAliases.length === 0}
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

        {/* Inline status in the existing Pending Queue / Process section (no extra panel). */}
        <div role='status' aria-live='polite' style={{ marginBottom: '12px', lineHeight: 1.75 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: '20px', rowGap: '2px' }}>
            <span><strong>Queue:</strong> {pendingAliases.length.toLocaleString()} pending</span>
            <span><strong>Processor:</strong> {processRunning ? 'Running' : 'Idle'}</span>
            {processProgress && <span><strong>This run:</strong> {processProgress.completed} completed
              {processProgress.initialPending !== null ? ` / ${processProgress.initialPending} initially pending` : ''}</span>}
            {processProgress && <span><strong>Started:</strong> {systemTimeLabel(processProgress.startedAt, serverTimeZone)}</span>}
            {processProgress && processRunning && clockMs !== null && <span><strong>Elapsed:</strong> {durationLabel(
              Math.max(0, (clockMs - Date.parse(processProgress.startedAt)) / 1000)
            )}</span>}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: '20px', rowGap: '2px' }}>
            <span><strong>Estimated completion:</strong>{' '}
              {processRunning && processProgress?.stalled ? 'No recent completions — check processor'
                : processRunning && processProgress?.estimatedCompletionAt && etaSeconds !== null
                ? `${systemTimeLabel(processProgress.estimatedCompletionAt, serverTimeZone)} (approximately ${durationLabel(etaSeconds)} remaining)`
                : !processRunning ? '— (processor idle)'
                : pendingAliases.length === 0 ? 'Queue empty'
                : 'Calculating from recent completions…'}
            </span>
            {processProgress?.recentSecondsPerItem !== null && processProgress?.recentSecondsPerItem !== undefined && (
              <span><strong>Recent average:</strong> ~{durationLabel(processProgress.recentSecondsPerItem)}/item
                {' · '}{processProgress.recentSampleCount} samples
                {' · '}{processProgress.estimateBasis === 'this-run' ? 'current run' : 'recent history'}
              </span>
            )}
          </div>
          {processProgress?.currentAlias && processRunning && (
            <div><strong>Current:</strong> <code>{processProgress.currentAlias}</code></div>
          )}
          {processProgress?.latestAlias && (
            <div><strong>Last completed:</strong> <code>{processProgress.latestAlias}</code>
              {processProgress.lastPromptTokens !== null && processProgress.lastCachedTokens !== null
                ? ` · ${processProgress.lastPromptTokens.toLocaleString()} prompt / ${processProgress.lastCachedTokens.toLocaleString()} cached tokens` : ''}
              {processProgress.lastPromptSeconds !== null ? ` · prompt ${durationLabel(processProgress.lastPromptSeconds)}` : ''}
              {processProgress.lastGenerationSeconds !== null ? ` · generate ${durationLabel(processProgress.lastGenerationSeconds)}` : ''}
              {processProgress.lastLlmSeconds !== null ? ` · total LLM ${durationLabel(processProgress.lastLlmSeconds)}` : ''}
              {` · repairs JSON ${processProgress.lastJsonRepairs} / wiki ${processProgress.lastWikiRepairs}`}
            </div>
          )}
          {!processRunning && processProgress?.latestError && (
            <div style={{ color: 'var(--bs-danger, #dc3545)' }}>
              <strong>Last failure:</strong> {processProgress.latestError}
            </div>
          )}
          <small style={{ opacity: 0.7 }}>
            ETA uses completion intervals and the G3 system clock; prompt caching, document length and retries can change it.
          </small>
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
                    <strong>{source?.title ?? ingestedByAlias.get(alias)?.title ?? alias}</strong>
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
                  <th style={{ textAlign: 'left', padding: '6px' }}>LLM time</th>
                  <th style={{ textAlign: 'left', padding: '6px' }}>Prompt / cached tokens</th>
                  <th style={{ textAlign: 'left', padding: '6px' }}>Repairs (JSON / wiki)</th>
                  <th style={{ textAlign: 'left', padding: '6px' }}>Time</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, HISTORY_LIMIT).map((row, index) => {
                  const alias = aliasOf(row)
                  const source = sourceByAlias.get(alias)
                  const timing = row.status === 'processed' ? runMetricsByAlias.get(alias) : undefined
                  return (
                    <tr key={`${row.id ?? alias}-${index}`}>
                      <td style={{ padding: '6px', borderTop: '1px solid var(--bs-border-color, #dee2e6)' }}>
                        {row.status ?? 'unknown'}
                      </td>
                      <td style={{ padding: '6px', borderTop: '1px solid var(--bs-border-color, #dee2e6)' }}>
                        {alias ? (
                          <Link href={`/n/${encodeURIComponent(alias)}`}>
                            {source?.title ?? ingestedByAlias.get(alias)?.title ?? alias}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td style={{ padding: '6px', borderTop: '1px solid var(--bs-border-color, #dee2e6)' }}>
                        {row.queueReason ?? '—'}
                      </td>
                      <td style={{ padding: '6px', borderTop: '1px solid var(--bs-border-color, #dee2e6)' }}>
                        {timing ? durationLabel(timing.llmSeconds) : '—'}
                      </td>
                      <td style={{ padding: '6px', borderTop: '1px solid var(--bs-border-color, #dee2e6)' }}>
                        {timing?.promptTokens != null && timing.cachedTokens != null
                          ? `${timing.promptTokens.toLocaleString()} / ${timing.cachedTokens.toLocaleString()}` : '—'}
                      </td>
                      <td style={{ padding: '6px', borderTop: '1px solid var(--bs-border-color, #dee2e6)' }}>
                        {timing ? `${timing.jsonRepairs} / ${timing.wikiRepairs}` : '—'}
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
          Uses the existing <code>/memex-rerun-batch</code> and scoped <code>/memex-process</code> flow. Any number may be selected; processing runs in batches of up to {SCOPED_RERUN_BATCH_SIZE} and verifies trail scope after each batch.
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

      <section style={panelStyle}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            alignItems: 'center'
          }}
        >
          <h2 style={{ margin: '0 auto 0 0' }}>
            Source-summary identity audit
          </h2>

          <button
            type='button'
            style={{ ...buttonStyle, fontWeight: 600 }}
            disabled={
              auditRunning ||
              processRunning ||
              doclingBatch.running ||
              doclingIngest.running
            }
            onClick={() => void runSourceSummaryAudit()}
          >
            {auditRunning ? 'Auditing…' : 'Run read-only audit'}
          </button>

          <button
            type='button'
            style={dangerButtonStyle}
            disabled={!auditRunning}
            onClick={() => auditAbortRef.current?.abort()}
          >
            Stop
          </button>
        </div>

        <p>
          Read-only audit of canonical, legacy, duplicate and corrupt
          source-summary identities. No notes or index entries are changed.
        </p>

        <div style={{ marginBottom: '8px' }}>
          <strong>Audit terminal</strong>
          <span style={{ marginLeft: '8px', opacity: 0.7 }}>
            {auditRunning ? 'live' : 'idle'}
          </span>
        </div>

        <pre
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
            maxHeight: '520px',
            minHeight: '180px',
            overflow: 'auto',
            padding: '12px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {auditLog || 'No audit run yet.'}
        </pre>
      </section>

      <section style={panelStyle}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            alignItems: 'center'
          }}
        >
          <h2 style={{ margin: '0 auto 0 0' }}>
            Source-summary cleanup
          </h2>

          <button
            type='button'
            style={{ ...buttonStyle, fontWeight: 600 }}
            disabled={
              cleanupRunning ||
              auditRunning ||
              processRunning ||
              doclingBatch.running ||
              doclingIngest.running
            }
            onClick={() => void runSourceSummaryCleanup('preview')}
          >
            {cleanupRunning && cleanupMode === 'preview'
              ? 'Previewing…'
              : 'Preview cleanup'}
          </button>

          <button
            type='button'
            style={dangerButtonStyle}
            disabled={
              cleanupRunning ||
              !cleanupPreviewHash ||
              cleanupConfirmation !== 'APPLY' ||
              auditRunning ||
              processRunning ||
              doclingBatch.running ||
              doclingIngest.running
            }
            onClick={() => void runSourceSummaryCleanup('apply')}
          >
            {cleanupRunning && cleanupMode === 'apply'
              ? 'Applying…'
              : 'Apply cleanup'}
          </button>

          <button
            type='button'
            style={buttonStyle}
            disabled={!cleanupRunning || cleanupMode !== 'preview'}
            onClick={() => cleanupAbortRef.current?.abort()}
          >
            Stop preview
          </button>
        </div>

        <p>
          Deterministic migration only; no LLM. Preview computes the safe
          old-alias → source-derived-alias plan. REVIEW, MULTI_SOURCE,
          NO_SOURCE and target collisions remain untouched. Apply snapshots
          the index and every affected legacy note before mutation.
        </p>

        <div
          style={{
            alignItems: 'center',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            marginBottom: '10px'
          }}
        >
          <label htmlFor='source-summary-cleanup-confirmation'>
            Confirmation
          </label>
          <input
            id='source-summary-cleanup-confirmation'
            type='text'
            value={cleanupConfirmation}
            disabled={cleanupRunning || !cleanupPreviewHash}
            placeholder='Type APPLY'
            onChange={(event) =>
              setCleanupConfirmation(event.target.value)
            }
            style={{
              minWidth: '180px',
              padding: '6px 8px'
            }}
          />
          <span style={{ opacity: 0.75 }}>
            {cleanupPreviewHash
              ? `${cleanupPlanCount} safe migrations previewed`
              : 'Preview required before apply'}
          </span>
        </div>

        <div style={{ marginBottom: '8px' }}>
          <strong>Cleanup terminal</strong>
          <span style={{ marginLeft: '8px', opacity: 0.7 }}>
            {cleanupRunning ? cleanupMode : 'idle'}
          </span>
        </div>

        <pre
          ref={cleanupTerminalRef}
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
            maxHeight: '520px',
            minHeight: '180px',
            overflow: 'auto',
            padding: '12px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {cleanupLog || 'No cleanup preview has been run yet.'}
        </pre>
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
