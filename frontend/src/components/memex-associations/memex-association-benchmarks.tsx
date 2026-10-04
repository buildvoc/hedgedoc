'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Badge, Button, Card, Form, Spinner, Table } from 'react-bootstrap'

interface BenchmarkRun {
  Run: string
  Created_at?: string
  Snapshot_name?: string
  Snapshot_revision?: string
  Candidate_model?: string
  Verifier_model?: string
  Mode?: string
  Prompt_version?: string
  Context_size?: number
  Temperature?: number
  Confidence_threshold?: number
  KV_cache_type?: string
  Flash_attention?: boolean | string
  Precision_assoc_avg?: number
  Recall_assoc_avg?: number
  F1_score_assoc_avg?: number
  False_positive_rate?: number
  Candidate_recall?: number
  True_positives?: number
  True_negatives?: number
  False_positives?: number
  False_negatives?: number
  Scoring_method?: string
  Evaluation_scope?: 'quick' | 'full'
  Pairs_total?: number
  Pairs_evaluated?: number
  Elapsed_seconds?: number
  metadata?: Record<string, string>
}

interface BenchmarkResult {
  source: string
  source_title?: string
  target: string
  target_title?: string
  gold_associated?: string
  candidate_found?: string
  verifier_associated?: string
  verifier_confidence?: string
  predicted_associated?: string
  outcome?: string
  reason?: string
  human_decision?: string
  elapsed_ms?: string
}

interface RunsResponse {
  runs?: BenchmarkRun[]
  error?: string
}

interface ResultsResponse {
  run?: BenchmarkRun
  results?: BenchmarkResult[]
  error?: string
}

interface BenchmarkGoldStatus {
  exists: boolean
  ready: boolean
  pairsExpected: number
  pairsPresent: number
  pairsLabeled: number
  unlabeled: number
  invalid: number
  missing: number
  extra: number
  path?: string
  storage?: 'snapshot' | 'legacy-fallback' | 'new'
  snapshotName?: string
}

interface BenchmarkGoldSource {
  alias: string
  title: string
  revisionId: string
  summary?: string
  llmSplit?: boolean
  splitOrigins?: string[]
}

interface BenchmarkGoldPair {
  source: string
  sourceTitle: string
  target: string
  targetTitle: string
  goldAssociated: boolean | null
  goldStrength?: string
  goldReason?: string
  reviewedBy?: string
  reviewedAt?: string
  llmSplitAssociated?: boolean
  splitOrigin?: string
  autoApplied?: boolean
}

interface BenchmarkGoldReviewResponse {
  snapshotRevision?: string
  autoApplied?: number
  snapshotName?: string
  sources?: BenchmarkGoldSource[]
  pairs?: BenchmarkGoldPair[]
  status?: BenchmarkGoldStatus
  path?: string
  storage?: 'snapshot' | 'legacy-fallback' | 'new'
  error?: string
}

interface BenchmarkActiveRun {
  runId: string
  pid?: number
  startedAt?: string
  snapshotRevision?: string
}

interface BenchmarkRunConfigResponse {
  models?: string[]
  defaultCandidateModel?: string
  defaultVerifierModel?: string
  defaultBenchmarkModel?: string
  defaultEvaluationScope?: 'quick' | 'full'
  quickMaxPairs?: number
  defaultNumCtx?: number
  defaultTemperature?: number
  defaultConfidenceThreshold?: number
  gold?: BenchmarkGoldStatus
  activeRun?: BenchmarkActiveRun
  error?: string
}

interface BenchmarkRunStateResponse extends BenchmarkActiveRun {
  state?: 'running' | 'completed' | 'failed'
  logTail?: string
  error?: string
}

const pct = (value: unknown): string => {
  const number = Number(value)
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : '—'
}

const numberOrZero = (value: unknown): number => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

const outcomeLabel: Record<string, string> = {
  true_positive: 'True positive',
  true_negative: 'True negative',
  false_positive: 'False positive',
  false_negative: 'False negative',
}

const outcomeBadge = (outcome?: string): string => {
  switch (outcome) {
    case 'true_positive':
      return 'success'
    case 'true_negative':
      return 'secondary'
    case 'false_positive':
      return 'danger'
    case 'false_negative':
      return 'warning'
    default:
      return 'secondary'
  }
}

const QualityChart: React.FC<{ runs: BenchmarkRun[] }> = ({ runs }) => {
  const width = 920
  const height = 300
  const padLeft = 58
  const padRight = 18
  const padTop = 20
  const padBottom = 54
  const chartWidth = width - padLeft - padRight
  const chartHeight = height - padTop - padBottom
  const x = (index: number) =>
    padLeft + (runs.length <= 1 ? chartWidth / 2 : (index / (runs.length - 1)) * chartWidth)
  const y = (value: number) => padTop + (1 - Math.max(0, Math.min(1, value))) * chartHeight
  const points = (key: keyof BenchmarkRun) =>
    runs.map((run, index) => `${x(index)},${y(numberOrZero(run[key]))}`).join(' ')

  if (!runs.length) {
    return <Alert variant='secondary'>No metric JSON files have been recorded yet.</Alert>
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg
        aria-label='Association benchmark quality trend'
        role='img'
        viewBox={`0 0 ${width} ${height}`}
        style={{ minWidth: '760px', width: '100%' }}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
          <g key={tick}>
            <line
              x1={padLeft}
              x2={width - padRight}
              y1={y(tick)}
              y2={y(tick)}
              stroke='currentColor'
              opacity='0.12'
            />
            <text x={8} y={y(tick) + 4} fontSize='12' fill='currentColor'>
              {(tick * 100).toFixed(0)}%
            </text>
          </g>
        ))}

        <polyline fill='none' stroke='currentColor' strokeWidth='3' points={points('Precision_assoc_avg')} />
        <polyline fill='none' stroke='currentColor' strokeDasharray='8 5' strokeWidth='2.5' points={points('Recall_assoc_avg')} />
        <polyline fill='none' stroke='currentColor' strokeDasharray='2 5' strokeWidth='2.5' points={points('F1_score_assoc_avg')} />

        {runs.map((run, index) => (
          <g key={run.Run}>
            <circle cx={x(index)} cy={y(numberOrZero(run.Precision_assoc_avg))} r='4' fill='currentColor' />
            <text
              fontSize='10'
              fill='currentColor'
              textAnchor='end'
              transform={`translate(${x(index) + 3} ${height - 12}) rotate(-35)`}
            >
              {run.Run}
            </text>
          </g>
        ))}
      </svg>
      <div className='small text-muted'>
        Solid: precision · dashed: recall · dotted: F1. False positives remain visible in the run table below.
      </div>
    </div>
  )
}

const AssociationNetwork: React.FC<{ results: BenchmarkResult[] }> = ({ results }) => {
  const edgeRows = results.filter((row) => row.outcome !== 'true_negative')
  const labels = Array.from(
    new Map(
      edgeRows.flatMap((row) => [
        [row.source, row.source_title || row.source],
        [row.target, row.target_title || row.target],
      ]),
    ).entries(),
  )

  if (!labels.length) {
    return <Alert variant='secondary'>No positive, missed, or false-positive benchmark edges in this run.</Alert>
  }

  const width = 760
  const height = 520
  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.min(width, height) * 0.36
  const positions = new Map(
    labels.map(([alias], index) => {
      const angle = (Math.PI * 2 * index) / labels.length - Math.PI / 2
      return [
        alias,
        {
          x: centerX + Math.cos(angle) * radius,
          y: centerY + Math.sin(angle) * radius,
        },
      ] as const
    }),
  )

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ minWidth: '680px', width: '100%' }}>
        {edgeRows.map((row, index) => {
          const left = positions.get(row.source)
          const right = positions.get(row.target)
          if (!left || !right) return null
          const dashed = row.outcome === 'false_negative'
          const heavy = row.outcome === 'false_positive'
          return (
            <line
              key={`${row.source}-${row.target}-${index}`}
              x1={left.x}
              y1={left.y}
              x2={right.x}
              y2={right.y}
              stroke='currentColor'
              strokeDasharray={dashed ? '7 5' : undefined}
              strokeWidth={heavy ? 4 : 2}
              opacity={row.outcome === 'true_positive' ? 0.65 : 0.95}
            />
          )
        })}
        {labels.map(([alias, title]) => {
          const point = positions.get(alias)!
          return (
            <g key={alias}>
              <circle cx={point.x} cy={point.y} r='18' fill='currentColor' opacity='0.14' />
              <circle cx={point.x} cy={point.y} r='5' fill='currentColor' />
              <text x={point.x} y={point.y + 34} textAnchor='middle' fontSize='12' fill='currentColor'>
                {title.length > 30 ? `${title.slice(0, 27)}…` : title}
              </text>
            </g>
          )
        })}
      </svg>
      <div className='small text-muted'>
        Solid = model-associated edge; dashed = false negative; heavier = false positive. True negatives are omitted.
      </div>
    </div>
  )
}

const goldPairKey = (left: string, right: string): string =>
  [left, right].sort().join('\u0000')

const GoldAssociationGraph: React.FC<{
  sources: BenchmarkGoldSource[]
  pairs: BenchmarkGoldPair[]
  selectedAliases: Set<string>
  onToggle: (alias: string) => void
  onAssociate: () => void
  onClear: () => void
}> = ({ sources, pairs, selectedAliases, onToggle, onAssociate, onClear }) => {
  const width = 900
  const height = 560
  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.min(width, height) * 0.36
  const positions = new Map<string, { x: number; y: number }>(
    sources.map((source, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, sources.length) - Math.PI / 2
      return [
        source.alias,
        {
          x: centerX + Math.cos(angle) * radius,
          y: centerY + Math.sin(angle) * radius,
        },
      ] as const
    }),
  )
  const associatedPairs = pairs.filter((pair) => pair.goldAssociated === true)
  const selected = sources.filter((source) => selectedAliases.has(source.alias))
  const previewPairs: Array<[string, string]> = []
  for (let left = 0; left < selected.length; left += 1) {
    for (let right = left + 1; right < selected.length; right += 1) {
      if (
        !associatedPairs.some(
          (pair) => goldPairKey(pair.source, pair.target) === goldPairKey(selected[left].alias, selected[right].alias),
        )
      ) {
        previewPairs.push([selected[left].alias, selected[right].alias])
      }
    }
  }

  return (
    <div>
      <div className='d-flex flex-wrap align-items-center gap-2 mb-2'>
        <Button size='sm' disabled={selectedAliases.size < 2} onClick={onAssociate}>
          Associate selected ({selectedAliases.size})
        </Button>
        <Button size='sm' variant='outline-secondary' disabled={!selectedAliases.size} onClick={onClear}>
          Clear selection
        </Button>
        <span className='small text-muted'>Select two or more nodes. Dashed lines preview the associations; Associate selected makes them solid gold labels.</span>
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid var(--bs-border-color)', borderRadius: '0.375rem' }}>
        <svg viewBox={`0 0 ${width} ${height}`} style={{ minWidth: '720px', width: '100%' }}>
          {associatedPairs.map((pair) => {
            const left = positions.get(pair.source)
            const right = positions.get(pair.target)
            if (!left || !right) return null
            return (
              <line
                key={`gold-${pair.source}-${pair.target}`}
                x1={left.x}
                y1={left.y}
                x2={right.x}
                y2={right.y}
                stroke='currentColor'
                strokeWidth={pair.llmSplitAssociated ? 4 : 2.5}
                opacity={pair.llmSplitAssociated ? 0.9 : 0.65}
              />
            )
          })}
          {previewPairs.map(([source, target]) => {
            const left = positions.get(source)
            const right = positions.get(target)
            if (!left || !right) return null
            return (
              <line
                key={`preview-${source}-${target}`}
                x1={left.x}
                y1={left.y}
                x2={right.x}
                y2={right.y}
                stroke='currentColor'
                strokeWidth='2'
                strokeDasharray='7 5'
                opacity='0.5'
              />
            )
          })}
          {sources.map((source) => {
            const point = positions.get(source.alias)!
            const selectedNode = selectedAliases.has(source.alias)
            return (
              <g
                key={source.alias}
                role='button'
                tabIndex={0}
                aria-label={`${selectedNode ? 'Deselect' : 'Select'} ${source.title}`}
                onClick={() => onToggle(source.alias)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onToggle(source.alias)
                  }
                }}
                style={{ cursor: 'pointer' }}
              >
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={selectedNode ? 25 : 21}
                  fill='currentColor'
                  opacity={selectedNode ? 0.28 : 0.12}
                />
                <circle cx={point.x} cy={point.y} r={selectedNode ? 8 : 6} fill='currentColor' />
                <text x={point.x} y={point.y + 38} textAnchor='middle' fontSize='12' fill='currentColor'>
                  {source.title.length > 34 ? `${source.title.slice(0, 31)}…` : source.title}
                </text>
                {source.llmSplit && (
                  <text x={point.x} y={point.y - 31} textAnchor='middle' fontSize='10' fill='currentColor'>
                    LLM split
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      <div className='small text-muted mt-2'>Solid lines are Associated gold labels only; this view does not write canonical Memex associations.</div>
    </div>
  )
}

interface MemexAssociationBenchmarksProps {
  snapshotRevision?: string
}

export const MemexAssociationBenchmarks: React.FC<MemexAssociationBenchmarksProps> = ({
  snapshotRevision = '',
}) => {
  const [runs, setRuns] = useState<BenchmarkRun[]>([])
  const [selectedRun, setSelectedRun] = useState('')
  const [results, setResults] = useState<BenchmarkResult[]>([])
  const [modelFilter, setModelFilter] = useState('')
  const [outcomeFilter, setOutcomeFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingResults, setLoadingResults] = useState(false)
  const [error, setError] = useState('')
  const [runConfig, setRunConfig] = useState<BenchmarkRunConfigResponse>()
  const [runConfigLoading, setRunConfigLoading] = useState(false)
  const [runError, setRunError] = useState('')
  const [benchmarkModel, setBenchmarkModel] = useState('')
  const [evaluationScope, setEvaluationScope] = useState<'quick' | 'full'>('quick')
  const [runNumCtx, setRunNumCtx] = useState(65536)
  const [runTemperature, setRunTemperature] = useState(0.35)
  const [runConfidenceThreshold, setRunConfidenceThreshold] = useState(0.85)
  const [runStarting, setRunStarting] = useState(false)
  const [activeRunId, setActiveRunId] = useState('')
  const [runState, setRunState] = useState<BenchmarkRunStateResponse>()
  const [goldReview, setGoldReview] = useState<BenchmarkGoldReviewResponse>()
  const [goldPairs, setGoldPairs] = useState<BenchmarkGoldPair[]>([])
  const [goldReviewLoading, setGoldReviewLoading] = useState(false)
  const [goldSaving, setGoldSaving] = useState(false)
  const [goldError, setGoldError] = useState('')
  const [goldDirty, setGoldDirty] = useState(false)
  const [goldReviewer, setGoldReviewer] = useState('human-ui')
  const [showOnlyUnlabeledGold, setShowOnlyUnlabeledGold] = useState(true)
  const [goldReviewMode, setGoldReviewMode] = useState<'wizard' | 'network'>('wizard')
  const [goldWizardIndex, setGoldWizardIndex] = useState(0)
  const [goldGraphSelection, setGoldGraphSelection] = useState<Set<string>>(new Set())

  const loadRuns = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/memex-association-benchmarks/data', { cache: 'no-store' })
      const payload = (await response.json()) as RunsResponse
      if (!response.ok) throw new Error(payload.error || `Benchmarks HTTP ${response.status}`)
      const nextRuns = payload.runs ?? []
      const eligibleRuns = snapshotRevision
        ? nextRuns.filter((run) => run.Snapshot_revision === snapshotRevision)
        : nextRuns
      setRuns(nextRuns)
      setSelectedRun((current) =>
        current && eligibleRuns.some((run) => run.Run === current)
          ? current
          : eligibleRuns.at(-1)?.Run || '',
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load benchmark runs')
    } finally {
      setLoading(false)
    }
  }, [snapshotRevision])

  const loadResults = useCallback(async (run: string) => {
    if (!run) {
      setResults([])
      return
    }
    setLoadingResults(true)
    setError('')
    try {
      const response = await fetch(`/memex-association-benchmarks/data?run=${encodeURIComponent(run)}`, {
        cache: 'no-store',
      })
      const payload = (await response.json()) as ResultsResponse
      if (!response.ok) throw new Error(payload.error || `Benchmark results HTTP ${response.status}`)
      setResults(payload.results ?? [])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load benchmark results')
      setResults([])
    } finally {
      setLoadingResults(false)
    }
  }, [])

  const loadGoldReview = useCallback(async () => {
    if (!snapshotRevision) {
      setGoldReview(undefined)
      setGoldPairs([])
      setGoldDirty(false)
      return
    }

    setGoldReviewLoading(true)
    setGoldError('')
    try {
      const response = await fetch(
        `/memex-association-benchmarks/gold?snapshotRevision=${encodeURIComponent(snapshotRevision)}`,
        { cache: 'no-store' },
      )
      const payload = (await response.json()) as BenchmarkGoldReviewResponse
      if (!response.ok) throw new Error(payload.error || `Gold review HTTP ${response.status}`)
      setGoldReview(payload)
      setGoldPairs(payload.pairs ?? [])
      setGoldDirty((payload.autoApplied ?? 0) > 0)
      setGoldWizardIndex(0)
      setGoldGraphSelection(new Set())
    } catch (caught) {
      setGoldError(caught instanceof Error ? caught.message : 'Unable to load gold review')
    } finally {
      setGoldReviewLoading(false)
    }
  }, [snapshotRevision])

  const loadRunConfig = useCallback(async () => {
    if (!snapshotRevision) {
      setRunConfig(undefined)
      setActiveRunId('')
      setRunState(undefined)
      return
    }

    setRunConfigLoading(true)
    setRunError('')
    try {
      const response = await fetch(
        `/memex-association-benchmarks/run?snapshotRevision=${encodeURIComponent(snapshotRevision)}`,
        { cache: 'no-store' },
      )
      const payload = (await response.json()) as BenchmarkRunConfigResponse
      if (!response.ok) throw new Error(payload.error || `Benchmark run config HTTP ${response.status}`)
      setRunConfig(payload)
      setBenchmarkModel((current) => current || payload.defaultBenchmarkModel || payload.defaultVerifierModel || payload.defaultCandidateModel || '')
      setEvaluationScope(payload.defaultEvaluationScope === 'full' ? 'full' : 'quick')
      setRunNumCtx(payload.defaultNumCtx ?? 65536)
      setRunTemperature(payload.defaultTemperature ?? 0.35)
      setRunConfidenceThreshold(payload.defaultConfidenceThreshold ?? 0.85)
      if (payload.activeRun?.runId) {
        setActiveRunId(payload.activeRun.runId)
        setRunState({ ...payload.activeRun, state: 'running' })
      }
    } catch (caught) {
      setRunError(caught instanceof Error ? caught.message : 'Unable to prepare benchmark run')
    } finally {
      setRunConfigLoading(false)
    }
  }, [snapshotRevision])

  const updateGoldPair = useCallback(
    (index: number, update: Partial<BenchmarkGoldPair>) => {
      setGoldPairs((current) =>
        current.map((pair, pairIndex) =>
          pairIndex === index ? { ...pair, ...update } : pair,
        ),
      )
      setGoldDirty(true)
    },
    [],
  )

  const saveGoldReview = useCallback(async () => {
    if (!snapshotRevision || !goldPairs.length) return
    setGoldSaving(true)
    setGoldError('')
    try {
      const response = await fetch('/memex-association-benchmarks/gold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snapshotRevision,
          reviewer: goldReviewer,
          pairs: goldPairs,
        }),
      })
      const payload = (await response.json()) as BenchmarkGoldReviewResponse
      if (!response.ok) throw new Error(payload.error || `Save gold review HTTP ${response.status}`)
      setGoldReview(payload)
      setGoldPairs(payload.pairs ?? [])
      setGoldDirty(false)
      await loadRunConfig()
    } catch (caught) {
      setGoldError(caught instanceof Error ? caught.message : 'Unable to save gold review')
    } finally {
      setGoldSaving(false)
    }
  }, [goldPairs, goldReviewer, loadRunConfig, snapshotRevision])

  const startBenchmark = useCallback(async () => {
    if (!snapshotRevision) return
    setRunStarting(true)
    setRunError('')
    try {
      const response = await fetch('/memex-association-benchmarks/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snapshotRevision,
          benchmarkModel,
          evaluationScope,
          numCtx: runNumCtx,
          temperature: runTemperature,
          confidenceThreshold: runConfidenceThreshold,
        }),
      })
      const payload = (await response.json()) as BenchmarkRunStateResponse
      if (!response.ok) throw new Error(payload.error || `Run benchmark HTTP ${response.status}`)
      if (!payload.runId) throw new Error('Benchmark runner did not return a run id')
      setActiveRunId(payload.runId)
      setRunState(payload)
    } catch (caught) {
      setRunError(caught instanceof Error ? caught.message : 'Unable to start benchmark')
    } finally {
      setRunStarting(false)
    }
  }, [
    benchmarkModel,
    evaluationScope,
    runConfidenceThreshold,
    runNumCtx,
    runTemperature,
    snapshotRevision,
  ])

  useEffect(() => {
    void loadRuns()
  }, [loadRuns])

  useEffect(() => {
    void loadResults(selectedRun)
  }, [loadResults, selectedRun])

  useEffect(() => {
    void loadRunConfig()
  }, [loadRunConfig])

  useEffect(() => {
    void loadGoldReview()
  }, [loadGoldReview])

  useEffect(() => {
    if (!activeRunId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      try {
        const response = await fetch(
          `/memex-association-benchmarks/run?run=${encodeURIComponent(activeRunId)}`,
          { cache: 'no-store' },
        )
        const payload = (await response.json()) as BenchmarkRunStateResponse
        if (!response.ok) throw new Error(payload.error || `Benchmark status HTTP ${response.status}`)
        if (cancelled) return
        setRunState(payload)

        if (payload.state === 'completed') {
          await loadRuns()
          if (!cancelled) {
            setSelectedRun(activeRunId)
            setActiveRunId('')
            await loadRunConfig()
          }
          return
        }
        if (payload.state === 'failed') {
          setRunError(
            payload.logTail
              ? `Benchmark failed. Last evaluator output:
${payload.logTail}`
              : 'Benchmark evaluator exited before producing metrics.',
          )
          setActiveRunId('')
          return
        }
        timer = setTimeout(() => void poll(), 3000)
      } catch (caught) {
        if (!cancelled) {
          setRunError(caught instanceof Error ? caught.message : 'Unable to poll benchmark status')
          timer = setTimeout(() => void poll(), 5000)
        }
      }
    }

    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [activeRunId, loadRunConfig, loadRuns])

  const snapshotRuns = useMemo(
    () =>
      snapshotRevision
        ? runs.filter((run) => run.Snapshot_revision === snapshotRevision)
        : runs,
    [runs, snapshotRevision],
  )

  const modelOptions = useMemo(
    () =>
      Array.from(
        new Set(
          snapshotRuns
            .flatMap((run) => [run.Candidate_model || '', run.Verifier_model || ''])
            .filter(Boolean),
        ),
      ).sort(),
    [snapshotRuns],
  )

  const runModelOptions = useMemo(
    () =>
      Array.from(
        new Set([
          ...(runConfig?.models ?? []),
          benchmarkModel,
        ].filter(Boolean)),
      ).sort(),
    [benchmarkModel, runConfig?.models],
  )

  const goldSourcesByAlias = useMemo(
    () => new Map((goldReview?.sources ?? []).map((source) => [source.alias, source])),
    [goldReview?.sources],
  )

  const labeledGoldPairs = useMemo(
    () => goldPairs.filter((pair) => typeof pair.goldAssociated === 'boolean').length,
    [goldPairs],
  )

  const visibleGoldPairs = useMemo(
    () =>
      showOnlyUnlabeledGold
        ? goldPairs
            .map((pair, index) => ({ pair, index }))
            .filter(({ pair }) => typeof pair.goldAssociated !== 'boolean' || pair.autoApplied)
        : goldPairs.map((pair, index) => ({ pair, index })),
    [goldPairs, showOnlyUnlabeledGold],
  )

  useEffect(() => {
    setGoldWizardIndex((current) =>
      Math.max(0, Math.min(current, Math.max(0, visibleGoldPairs.length - 1))),
    )
  }, [visibleGoldPairs.length])

  const labelGoldPair = useCallback(
    (index: number, associated: boolean) => {
      const pair = goldPairs[index]
      if (!pair || pair.llmSplitAssociated) return
      updateGoldPair(index, { goldAssociated: associated, autoApplied: false })
      if (!showOnlyUnlabeledGold) {
        setGoldWizardIndex((current) => Math.min(current + 1, Math.max(0, goldPairs.length - 1)))
      }
    },
    [goldPairs, showOnlyUnlabeledGold, updateGoldPair],
  )

  const toggleGoldGraphSource = useCallback((alias: string) => {
    setGoldGraphSelection((current) => {
      const next = new Set(current)
      if (next.has(alias)) next.delete(alias)
      else next.add(alias)
      return next
    })
  }, [])

  const associateGoldGraphSelection = useCallback(() => {
    if (goldGraphSelection.size < 2) return
    setGoldPairs((current) =>
      current.map((pair) =>
        goldGraphSelection.has(pair.source) && goldGraphSelection.has(pair.target)
          ? { ...pair, goldAssociated: true, autoApplied: false }
          : pair,
      ),
    )
    setGoldDirty(true)
    setGoldGraphSelection(new Set())
  }, [goldGraphSelection])

  const filteredRuns = useMemo(
    () =>
      modelFilter
        ? snapshotRuns.filter(
            (run) => run.Candidate_model === modelFilter || run.Verifier_model === modelFilter,
          )
        : snapshotRuns,
    [modelFilter, snapshotRuns],
  )

  const filteredResults = useMemo(
    () => (outcomeFilter ? results.filter((row) => row.outcome === outcomeFilter) : results),
    [outcomeFilter, results],
  )

  if (loading) {
    return (
      <div className='d-flex align-items-center gap-2'>
        <Spinner animation='border' size='sm' /> Loading benchmark metric files…
      </div>
    )
  }

  return (
    <div className='d-grid gap-4'>
      {error && <Alert variant='warning'>{error}</Alert>}

      {snapshotRevision && (
        <Alert variant='info' className='mb-0'>
          Benchmark view pinned to snapshot revision <code>{snapshotRevision}</code>.{' '}
          <a href='/memex-association-benchmarks'>Show all snapshot revisions</a>.
        </Alert>
      )}

      {snapshotRevision && (
        <Card>
          <Card.Body>
            <div className='d-flex flex-wrap justify-content-between align-items-start gap-3 mb-3'>
              <div>
                <h2 className='h4 mb-1'>Gold review</h2>
                <p className='text-muted mb-0'>Review one pair at a time, or build gold associations directly on the source network.</p>
              </div>
              <div className='text-end small'>
                <strong>{labeledGoldPairs}/{goldPairs.length || goldReview?.status?.pairsExpected || 0}</strong> labeled
                {goldDirty && <Badge bg='warning' text='dark' className='ms-2'>Unsaved</Badge>}
              </div>
            </div>

            {goldReviewLoading ? (
              <div className='d-flex align-items-center gap-2'>
                <Spinner animation='border' size='sm' /> Loading frozen source pairs…
              </div>
            ) : (
              <>
                {goldError && <Alert variant='warning' style={{ whiteSpace: 'pre-wrap' }}>{goldError}</Alert>}

                {(goldReview?.autoApplied ?? 0) > 0 && (
                  <Alert variant='info'>
                    {goldReview?.autoApplied} LLM-split pair{goldReview?.autoApplied === 1 ? '' : 's'} automatically set to <strong>Associated</strong> with strength <strong>1</strong> and a split-provenance reason. Save the gold set to persist these labels.
                  </Alert>
                )}

                {goldReview?.storage === 'legacy-fallback' && (
                  <Alert variant='info'>
                    Existing <code>gold.tsv</code> matches this snapshot and is shown as a legacy fallback. Saving creates a revision-specific gold file for this snapshot.
                  </Alert>
                )}

                <div className='d-flex flex-wrap align-items-end gap-3 mb-3'>
                  <Form.Group style={{ minWidth: '220px' }}>
                    <Form.Label>Reviewer</Form.Label>
                    <Form.Control value={goldReviewer} maxLength={120} onChange={(event) => setGoldReviewer(event.target.value)} />
                  </Form.Group>
                  <Form.Check
                    type='checkbox'
                    label='Show only unlabeled / new auto labels'
                    checked={showOnlyUnlabeledGold}
                    onChange={(event) => {
                      setShowOnlyUnlabeledGold(event.target.checked)
                      setGoldWizardIndex(0)
                    }}
                  />
                  <div className='d-flex gap-2'>
                    <Button size='sm' variant={goldReviewMode === 'wizard' ? 'primary' : 'outline-secondary'} onClick={() => setGoldReviewMode('wizard')}>
                      Pair wizard
                    </Button>
                    <Button size='sm' variant={goldReviewMode === 'network' ? 'primary' : 'outline-secondary'} onClick={() => setGoldReviewMode('network')}>
                      Network graph
                    </Button>
                  </div>
                  <Button onClick={() => void saveGoldReview()} disabled={!goldDirty || goldSaving || !goldPairs.length}>
                    {goldSaving ? <><Spinner animation='border' size='sm' className='me-2' />Saving…</> : 'Save Gold Set'}
                  </Button>
                </div>

                {goldReviewMode === 'network' ? (
                  <GoldAssociationGraph
                    sources={goldReview?.sources ?? []}
                    pairs={goldPairs}
                    selectedAliases={goldGraphSelection}
                    onToggle={toggleGoldGraphSource}
                    onAssociate={associateGoldGraphSelection}
                    onClear={() => setGoldGraphSelection(new Set())}
                  />
                ) : visibleGoldPairs.length === 0 ? (
                  <Alert variant='success' className='mb-0'>
                    All {goldPairs.length} pairs are labeled. Save any unsaved changes, then Run Benchmark is enabled.
                  </Alert>
                ) : (() => {
                  const current = visibleGoldPairs[goldWizardIndex] ?? visibleGoldPairs[0]
                  const pair = current.pair
                  const source = goldSourcesByAlias.get(pair.source)
                  const target = goldSourcesByAlias.get(pair.target)
                  return (
                    <div>
                      <div className='d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3'>
                        <div className='small text-muted'>Pair {goldWizardIndex + 1} of {visibleGoldPairs.length}</div>
                        <div className='d-flex gap-2'>
                          <Button size='sm' variant='outline-secondary' disabled={goldWizardIndex <= 0} onClick={() => setGoldWizardIndex((currentIndex) => Math.max(0, currentIndex - 1))}>
                            Previous
                          </Button>
                          <Button size='sm' variant='outline-secondary' disabled={goldWizardIndex >= visibleGoldPairs.length - 1} onClick={() => setGoldWizardIndex((currentIndex) => Math.min(visibleGoldPairs.length - 1, currentIndex + 1))}>
                            Next
                          </Button>
                        </div>
                      </div>

                      <Card className='mb-0'>
                        <Card.Body>
                          <div className='d-flex flex-wrap align-items-start justify-content-between gap-2 mb-3'>
                            <div>
                              <h3 className='h5 mb-1'>{pair.sourceTitle}</h3>
                              <div className='text-muted'>↔ {pair.targetTitle}</div>
                            </div>
                            {pair.llmSplitAssociated && <Badge bg='success'>LLM split · auto Associated</Badge>}
                          </div>

                          <div className='row g-3 mb-3'>
                            <div className='col-md-6'>
                              <div className='border rounded p-3 h-100'>
                                <strong>{pair.sourceTitle}</strong>
                                <div className='small text-muted mb-1'>Memex index summary</div>
                                <div className='small'>{source?.summary || 'No current Memex index summary is available.'}</div>
                              </div>
                            </div>
                            <div className='col-md-6'>
                              <div className='border rounded p-3 h-100'>
                                <strong>{pair.targetTitle}</strong>
                                <div className='small text-muted mb-1'>Memex index summary</div>
                                <div className='small'>{target?.summary || 'No current Memex index summary is available.'}</div>
                              </div>
                            </div>
                          </div>

                          <div className='d-flex flex-wrap gap-2 mb-3'>
                            <Button
                              variant={pair.goldAssociated === true ? 'success' : 'outline-success'}
                              onClick={() => labelGoldPair(current.index, true)}
                              disabled={pair.llmSplitAssociated}
                            >
                              Associated
                            </Button>
                            <Button
                              variant={pair.goldAssociated === false ? 'secondary' : 'outline-secondary'}
                              onClick={() => labelGoldPair(current.index, false)}
                              disabled={pair.llmSplitAssociated}
                            >
                              No association
                            </Button>
                            <Button
                              variant='outline-secondary'
                              disabled={pair.goldAssociated === null || pair.llmSplitAssociated}
                              onClick={() => updateGoldPair(current.index, { goldAssociated: null, autoApplied: false })}
                            >
                              Clear
                            </Button>
                          </div>

                          {pair.llmSplitAssociated && (
                            <Alert variant='success' className='py-2'>
                              Both notes carry <code>llm-split</code> provenance and share the same split source, so this gold pair is deterministic.
                            </Alert>
                          )}

                          <div className='row g-3'>
                            <div className='col-md-9'>
                              <Form.Group>
                                <Form.Label>Reason</Form.Label>
                                <Form.Control
                                  value={pair.goldReason ?? ''}
                                  readOnly={pair.llmSplitAssociated}
                                  placeholder='Gold-standard reason'
                                  onChange={(event) => updateGoldPair(current.index, { goldReason: event.target.value })}
                                />
                              </Form.Group>
                            </div>
                            <div className='col-md-3'>
                              <Form.Group>
                                <Form.Label>Strength</Form.Label>
                                <Form.Control
                                  type='number'
                                  min={0}
                                  max={1}
                                  step={0.05}
                                  value={pair.goldStrength ?? ''}
                                  readOnly={pair.llmSplitAssociated}
                                  placeholder='0–1'
                                  onChange={(event) => updateGoldPair(current.index, { goldStrength: event.target.value })}
                                />
                              </Form.Group>
                            </div>
                          </div>
                        </Card.Body>
                      </Card>
                    </div>
                  )
                })()}
              </>
            )}
          </Card.Body>
        </Card>
      )}

      {snapshotRevision && (
        <Card>
          <Card.Body>
            <h2 className='h4'>Run benchmark</h2>
            <p className='text-muted mb-3'>
              Screen one model directly against the frozen gold set. Quick mode reduces runtime; Full mode evaluates every pair.
              Benchmarking writes results and metrics only and never changes canonical Memex associations.
            </p>

            {runConfigLoading ? (
              <div className='d-flex align-items-center gap-2'>
                <Spinner animation='border' size='sm' /> Preparing snapshot benchmark…
              </div>
            ) : (
              <>
                {runError && (
                  <Alert variant='warning' style={{ whiteSpace: 'pre-wrap' }}>
                    {runError}
                  </Alert>
                )}

                {runConfig?.gold && (
                  <Alert variant={runConfig.gold.ready ? 'success' : 'warning'}>
                    <strong>Gold set:</strong> {runConfig.gold.pairsLabeled}/{runConfig.gold.pairsExpected} pairs labeled.
                    {!runConfig.gold.ready && (
                      <span>
                        {' '}Complete and save the Gold review above before running this snapshot
                        ({runConfig.gold.missing} missing, {runConfig.gold.extra} extra, {runConfig.gold.invalid} invalid/unlabeled).
                      </span>
                    )}
                  </Alert>
                )}

                <div className='d-flex flex-wrap align-items-end gap-3'>
                  <Form.Group style={{ minWidth: '320px', flex: '1 1 320px' }}>
                    <Form.Label>Benchmark model</Form.Label>
                    <Form.Select value={benchmarkModel} onChange={(event) => setBenchmarkModel(event.target.value)}>
                      {runModelOptions.map((model) => (
                        <option key={model} value={model}>{model}</option>
                      ))}
                    </Form.Select>
                  </Form.Group>

                  <Form.Group style={{ minWidth: '220px' }}>
                    <Form.Label>Run size</Form.Label>
                    <Form.Select
                      value={evaluationScope}
                      onChange={(event) => setEvaluationScope(event.target.value === 'full' ? 'full' : 'quick')}
                    >
                      <option value='quick'>Quick · up to {runConfig?.quickMaxPairs ?? 40} pairs</option>
                      <option value='full'>Full · all {runConfig?.gold?.pairsExpected ?? 'snapshot'} pairs</option>
                    </Form.Select>
                  </Form.Group>
                </div>

                <div className='small text-muted mt-2'>
                  Quick is a deterministic balanced screening sample, so every model sees the same pairs. Use Full for the final benchmark score.
                </div>

                <details className='mt-3'>
                  <summary>Advanced settings</summary>
                  <div className='d-flex flex-wrap align-items-end gap-3 mt-2'>
                    <Form.Group style={{ minWidth: '150px' }}>
                      <Form.Label>Context</Form.Label>
                      <Form.Control
                        type='number'
                        min={1024}
                        max={1048576}
                        step={1024}
                        value={runNumCtx}
                        onChange={(event) => setRunNumCtx(Number(event.target.value))}
                      />
                    </Form.Group>

                    <Form.Group style={{ minWidth: '140px' }}>
                      <Form.Label>Temperature</Form.Label>
                      <Form.Control
                        type='number'
                        min={0}
                        max={2}
                        step={0.05}
                        value={runTemperature}
                        onChange={(event) => setRunTemperature(Number(event.target.value))}
                      />
                    </Form.Group>

                    <Form.Group style={{ minWidth: '160px' }}>
                      <Form.Label>Min confidence</Form.Label>
                      <Form.Control
                        type='number'
                        min={0}
                        max={1}
                        step={0.01}
                        value={runConfidenceThreshold}
                        onChange={(event) => setRunConfidenceThreshold(Number(event.target.value))}
                      />
                    </Form.Group>
                  </div>
                </details>

                <div className='d-flex flex-wrap align-items-center gap-3 mt-3'>
                  <Button
                    onClick={() => void startBenchmark()}
                    disabled={
                      runStarting ||
                      Boolean(activeRunId) ||
                      !runConfig?.gold?.ready ||
                      !benchmarkModel
                    }
                  >
                    {runStarting ? (
                      <><Spinner animation='border' size='sm' className='me-2' />Starting…</>
                    ) : activeRunId ? (
                      'Benchmark running…'
                    ) : (
                      'Run Benchmark'
                    )}
                  </Button>

                  {runState?.state === 'running' && (
                    <span className='small'>
                      Running <code>{runState.runId}</code>. This page polls for metrics automatically.
                    </span>
                  )}
                  {runState?.state === 'completed' && (
                    <span className='small text-success'>Benchmark completed and the charts were refreshed.</span>
                  )}
                </div>
              </>
            )}
          </Card.Body>
        </Card>
      )}

      <Card>
        <Card.Body>
          <div className='d-flex flex-wrap align-items-end gap-3 mb-3'>
            <Form.Group style={{ minWidth: '280px' }}>
              <Form.Label>Model filter</Form.Label>
              <Form.Select value={modelFilter} onChange={(event) => setModelFilter(event.target.value)}>
                <option value=''>All models</option>
                {modelOptions.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </Form.Select>
            </Form.Group>
            <div className='small text-muted'>
              {filteredRuns.length} run{filteredRuns.length === 1 ? '' : 's'} discovered from metric JSON files.
            </div>
          </div>
          <h2 className='h4'>Quality trend</h2>
          <QualityChart runs={filteredRuns} />
        </Card.Body>
      </Card>

      <Card>
        <Card.Body>
          <h2 className='h4'>Run ledger</h2>
          <div className='small text-muted mb-2'>
            Decision scoring compares the model&apos;s associated=true/false answer directly with gold. Confidence is diagnostic and no longer suppresses a positive decision. Existing TSV runs are rescored automatically.
          </div>
          <div style={{ overflowX: 'auto' }}>
            <Table bordered hover responsive size='sm'>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Model</th>
                  <th>Scope</th>
                  <th>Decision Precision</th>
                  <th>Decision Recall</th>
                  <th>Decision F1</th>
                  <th>FP</th>
                  <th>FN</th>
                  <th>Pairs</th>
                  <th>Runtime</th>
                </tr>
              </thead>
              <tbody>
                {[...filteredRuns]
                  .sort((a, b) =>
                    String(b.Created_at ?? b.Run).localeCompare(String(a.Created_at ?? a.Run)),
                  )
                  .map((run) => (
                    <tr
                      key={run.Run}
                      onClick={() => setSelectedRun(run.Run)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td><code>{run.Run}</code></td>
                      <td><code>{run.Mode === 'verifier' ? (run.Verifier_model || run.Candidate_model || '—') : `${run.Candidate_model || '—'} → ${run.Verifier_model || '—'}`}</code></td>
                      <td>{run.Evaluation_scope === 'quick' ? 'Quick' : run.Evaluation_scope === 'full' ? 'Full' : run.Mode === 'pipeline' ? 'Pipeline' : 'Legacy'}</td>
                      <td>{pct(run.Precision_assoc_avg)}</td>
                      <td>{pct(run.Recall_assoc_avg)}</td>
                      <td>{pct(run.F1_score_assoc_avg)}</td>
                      <td>{run.False_positives ?? '—'}</td>
                      <td>{run.False_negatives ?? '—'}</td>
                      <td>{run.Pairs_evaluated ?? '—'}{run.Pairs_total ? `/${run.Pairs_total}` : ''}</td>
                      <td>{Number.isFinite(Number(run.Elapsed_seconds)) ? `${Number(run.Elapsed_seconds).toFixed(1)}s` : '—'}</td>
                    </tr>
                  ))}
              </tbody>
            </Table>
          </div>
        </Card.Body>
      </Card>

      <Card>
        <Card.Body>
          <div className='d-flex flex-wrap align-items-end gap-3 mb-3'>
            <Form.Group style={{ minWidth: '320px' }}>
              <Form.Label>Detailed results run</Form.Label>
              <Form.Select value={selectedRun} onChange={(event) => setSelectedRun(event.target.value)}>
                <option value=''>Select a run</option>
                {snapshotRuns.map((run) => (
                  <option key={run.Run} value={run.Run}>{run.Run}</option>
                ))}
              </Form.Select>
            </Form.Group>
            <Form.Group style={{ minWidth: '200px' }}>
              <Form.Label>Outcome</Form.Label>
              <Form.Select value={outcomeFilter} onChange={(event) => setOutcomeFilter(event.target.value)}>
                <option value=''>All outcomes</option>
                {Object.entries(outcomeLabel).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </Form.Select>
            </Form.Group>
          </div>

          {loadingResults ? (
            <div className='d-flex align-items-center gap-2'><Spinner animation='border' size='sm' /> Loading detailed results…</div>
          ) : (
            <>
              <h2 className='h4'>Pair results</h2>
              <div style={{ overflowX: 'auto', maxHeight: '520px' }}>
                <Table bordered hover responsive size='sm'>
                  <thead>
                    <tr>
                      <th>Source A</th>
                      <th>Source B</th>
                      <th>Gold</th>
                      <th>Prediction</th>
                      <th>Confidence</th>
                      <th>Outcome</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredResults.map((row, index) => (
                      <tr key={`${row.source}-${row.target}-${index}`}>
                        <td>{row.source_title || row.source}</td>
                        <td>{row.target_title || row.target}</td>
                        <td>{row.gold_associated === 'true' ? 'Associated' : 'No association'}</td>
                        <td>{row.predicted_associated === 'true' ? 'Associated' : 'No association'}</td>
                        <td>{pct(row.verifier_confidence)}</td>
                        <td><Badge bg={outcomeBadge(row.outcome)}>{outcomeLabel[row.outcome || ''] || row.outcome || '—'}</Badge></td>
                        <td style={{ minWidth: '320px' }}>{row.reason || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>

              <h2 className='h4 mt-4'>Association network</h2>
              <AssociationNetwork results={results} />
            </>
          )}
        </Card.Body>
      </Card>
    </div>
  )
}
