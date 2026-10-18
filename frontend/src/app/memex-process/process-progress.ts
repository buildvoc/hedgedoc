/**
 * Read-only Memex queue progress calculations. Clock values come from G3's
 * system clock; the browser localizes the resulting completion timestamp.
 */
export type ProcessedQueueRow = {
  alias?: string
  status?: string
  processedAt?: string
}

export type MemexProcessProgress = {
  startedAt: string
  elapsedSeconds: number
  initialPending: number | null
  completed: number
  remaining: number
  currentAlias: string | null
  latestAlias: string | null
  recentSecondsPerItem: number | null
  recentSampleCount: number
  estimateBasis: 'this-run' | 'recent-history' | 'insufficient-data'
  estimatedCompletionAt: string | null
  remainingSeconds: number | null
  lastLlmSeconds: number | null
  lastPromptTokens: number | null
  lastCachedTokens: number | null
  lastJsonRepairs: number
  lastWikiRepairs: number
  latestError: string | null
  stalled: boolean
  lastPromptSeconds: number | null
  lastGenerationSeconds: number | null
  completedItems: Array<{
    alias: string
    llmSeconds: number
    promptTokens: number | null
    cachedTokens: number | null
    jsonRepairs: number
    wikiRepairs: number
  }>
}

type Batch = {
  alias: string
  success: boolean
  llmMilliseconds: number
  promptMilliseconds: number | null
  generationMilliseconds: number | null
  promptTokens: number | null
  cachedTokens: number | null
  jsonRepairs: number
  wikiRepairs: number
}

const sampleAverage = (samples: number[]): number | null =>
  samples.length > 0 ? samples.reduce((sum, value) => sum + value, 0) / samples.length : null

/** Limit history-based samples to continuous batches, not overnight pauses. */
const HISTORY_MAX_GAP_MS = 15 * 60 * 1000
const HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000
const SAMPLE_COUNT = 6

function historySamples(rows: ProcessedQueueRow[], nowMs: number): number[] {
  const times = rows
    .filter((row) => row.status === 'processed' && typeof row.processedAt === 'string')
    .map((row) => Date.parse(row.processedAt as string))
    .filter((time) => Number.isFinite(time) && time <= nowMs && nowMs - time < HISTORY_MAX_AGE_MS)
    .sort((a, b) => a - b)
  const samples: number[] = []
  for (let index = Math.max(1, times.length - SAMPLE_COUNT); index < times.length; index += 1) {
    const delta = times[index] - times[index - 1]
    if (delta >= 1000 && delta <= HISTORY_MAX_GAP_MS) samples.push(delta)
  }
  return samples.slice(-SAMPLE_COUNT)
}

export function summarizeMemexProgress(
  log: string,
  rows: ProcessedQueueRow[],
  remaining: number,
  running: boolean,
  nowMs: number
): MemexProcessProgress | null {
  // A log may contain several runs. Never combine timings across runs.
  const marker = '[memex-process] '
  const startIndex = log.lastIndexOf(marker)
  if (startIndex < 0) return null
  const currentLog = log.slice(startIndex)
  const startMatch = currentLog.match(/^\[memex-process\] (\S+) start(?:\s|$)/)
  if (!startMatch) return null
  const startedMs = Date.parse(startMatch[1])
  if (!Number.isFinite(startedMs) || startedMs > nowMs + 60_000) return null

  const initialMatch = currentLog.match(/^MEMEX batch start: pending=(\d+)/m)
  const initialPending = initialMatch ? Number(initialMatch[1]) : null
  const batches: Batch[] = []
  let batch: Batch | null = null
  let latestError: string | null = null
  for (const line of currentLog.split(/\r?\n/)) {
    const item = line.match(/^MEMEX batch \[\d+\]: pending=\d+ next=(\S+)/)
    if (item) {
      batch = {
        alias: item[1], success: false, llmMilliseconds: 0,
        promptMilliseconds: null, generationMilliseconds: null,
        promptTokens: null, cachedTokens: null, jsonRepairs: 0, wikiRepairs: 0
      }
      batches.push(batch)
      continue
    }
    if (!batch) continue
    const telemetry = line.match(
      /^MEMEX llama\.cpp telemetry: prompt=(\d+) cached=(\d+) prompt_ms=([\d.]+) generated=\d+ generation_ms=([\d.]+)/
    )
    if (telemetry) {
      if (batch.promptTokens === null) {
        batch.promptTokens = Number(telemetry[1])
        batch.cachedTokens = Number(telemetry[2])
        batch.promptMilliseconds = Number(telemetry[3])
        batch.generationMilliseconds = Number(telemetry[4])
      }
      batch.llmMilliseconds += Number(telemetry[3]) + Number(telemetry[4])
    }
    if (line.startsWith('MEMEX JSON repair attempt ')) batch.jsonRepairs += 1
    if (line.startsWith('MEMEX wiki contract repair attempt ')) batch.wikiRepairs += 1
    if (line === 'queue status: processed') batch.success = true
    if (line.startsWith('ERROR: ') || line.startsWith('RuntimeError: ')) latestError = line
  }

  const completedBatches = batches.filter((item) => item.success)
  const latest = completedBatches[completedBatches.length - 1]
  const inFlight = batches.length > 0 && !batches[batches.length - 1].success
    ? batches[batches.length - 1] : null

  // Match completion timestamps to the aliases reported by this particular run.
  // This gives true wall-clock throughput, including JSON/wiki repairs and I/O.
  const completionByAlias = new Map<string, number>()
  for (const row of rows) {
    if (row.status !== 'processed' || !row.alias || !row.processedAt) continue
    const time = Date.parse(row.processedAt)
    if (!Number.isFinite(time) || time < startedMs || time > nowMs + 60_000) continue
    const previous = completionByAlias.get(row.alias) ?? 0
    if (time > previous) completionByAlias.set(row.alias, time)
  }

  const completionTimes = completedBatches
    .map((item) => completionByAlias.get(item.alias))
    .filter((time): time is number => time !== undefined)
    .sort((a, b) => a - b)
  const currentSamples: number[] = []
  let previous = startedMs
  for (const time of completionTimes) {
    const delta = time - previous
    if (delta >= 1000 && delta <= HISTORY_MAX_GAP_MS) currentSamples.push(delta)
    previous = time
  }
  const latestSamples = currentSamples.slice(-SAMPLE_COUNT)
  const useRunSamples = latestSamples.length >= 2
  const samples = useRunSamples ? latestSamples : historySamples(rows, nowMs)
  const averageMs = sampleAverage(samples)
  const estimateBasis = averageMs === null ? 'insufficient-data'
    : useRunSamples ? 'this-run' : 'recent-history'

  // A live process may be unresponsive despite still appearing in pgrep.
  // Suppress a misleading ETA if no document has finished for too long.
  const latestFinishMs = completionTimes[completionTimes.length - 1] ?? startedMs
  const stalled = running && remaining > 0 &&
    nowMs - latestFinishMs > Math.max(HISTORY_MAX_GAP_MS, (averageMs ?? 0) * 4)

  let remainingSeconds: number | null = null
  let estimatedCompletionAt: string | null = null
  if (running && remaining > 0 && averageMs !== null && !stalled) {
    const activeSince = completionTimes.length > 0
      ? completionTimes[completionTimes.length - 1] : startedMs
    const activeMs = Math.max(0, nowMs - activeSince)
    // Remaining includes the in-flight document. Allow a partial-item credit,
    // without claiming the model must finish within its average duration.
    const remainingMs = Math.max(0, remaining * averageMs - Math.min(activeMs, averageMs * 0.9))
    remainingSeconds = Math.round(remainingMs / 1000)
    estimatedCompletionAt = new Date(nowMs + remainingMs).toISOString()
  }

  return {
    startedAt: new Date(startedMs).toISOString(),
    elapsedSeconds: Math.max(0, Math.floor((nowMs - startedMs) / 1000)),
    initialPending,
    completed: completedBatches.length,
    remaining,
    currentAlias: inFlight?.alias ?? null,
    latestAlias: latest?.alias ?? null,
    recentSecondsPerItem: averageMs === null ? null : Math.round(averageMs / 1000),
    recentSampleCount: samples.length,
    estimateBasis,
    estimatedCompletionAt,
    remainingSeconds,
    lastLlmSeconds: latest ? Math.round(latest.llmMilliseconds / 1000) : null,
    lastPromptTokens: latest?.promptTokens ?? null,
    lastCachedTokens: latest?.cachedTokens ?? null,
    lastJsonRepairs: latest?.jsonRepairs ?? 0,
    lastWikiRepairs: latest?.wikiRepairs ?? 0,
    latestError,
    stalled,
    lastPromptSeconds: latest?.promptMilliseconds === null || latest === undefined
      ? null : Math.round(latest.promptMilliseconds / 1000),
    lastGenerationSeconds: latest?.generationMilliseconds === null || latest === undefined
      ? null : Math.round(latest.generationMilliseconds / 1000),
    completedItems: completedBatches.slice(-30).map((item) => ({
      alias: item.alias,
      llmSeconds: Math.round(item.llmMilliseconds / 1000),
      promptTokens: item.promptTokens,
      cachedTokens: item.cachedTokens,
      jsonRepairs: item.jsonRepairs,
      wikiRepairs: item.wikiRepairs
    }))
  }
}
