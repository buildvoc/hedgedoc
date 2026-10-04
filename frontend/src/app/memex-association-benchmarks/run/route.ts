import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { readMemexApiToken } from '../../memex-revisions/_proxy'
import { readMemexModelSettings } from '../../memex-model-settings/_settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PROJECT_ROOT = process.env.MEMEX_PROJECT_ROOT ?? '/data/projects/hedgedoc'
const ROOT =
  process.env.MEMEX_ASSOCIATION_BENCHMARK_PATH ??
  join(PROJECT_ROOT, 'memex/benchmarks/association')
const LEGACY_GOLD_FILE =
  process.env.MEMEX_ASSOCIATION_BENCHMARK_GOLD_FILE ?? join(ROOT, 'gold.tsv')
const GOLD_DIR =
  process.env.MEMEX_ASSOCIATION_BENCHMARK_GOLD_DIR ?? join(ROOT, 'gold')
const RESULTS_DIR = join(ROOT, 'results')
const METRICS_DIR = join(ROOT, 'metrics')
const STATUS_DIR = join(ROOT, 'status')
const LOG_DIR = join(ROOT, 'logs')
const RUNS_MD = join(ROOT, 'BenchmarkRuns.md')
const EVALUATOR =
  process.env.MEMEX_ASSOCIATION_EVAL_PATH ?? join(PROJECT_ROOT, 'memex/association_eval.py')
const PYTHON = process.env.MEMEX_PYTHON ?? 'python3'
const HEDGEDOC_NOTES_API =
  process.env.HEDGEDOC_NOTES_API ?? 'http://127.0.0.1:3100/api/v2/notes'
const SNAPSHOTS_ALIAS = 'memex-snapshots'
const revisionPattern = /^[0-9a-f-]{16,64}$/i
const runPattern = /^[A-Za-z0-9_.:+@-]{1,180}$/
const modelPattern = /^[A-Za-z0-9_.:/@+\-]{1,160}$/

interface StatusFile {
  runId: string
  pid: number
  snapshotRevision: string
  candidateModel: string
  verifierModel: string
  mode: 'verifier' | 'pipeline'
  evaluationScope?: 'quick' | 'full'
  maxPairs?: number
  startedAt: string
  logFile: string
}

interface SnapshotManifest {
  name?: string
  sources?: Array<{ alias?: string; title?: string; revisionId?: string }>
}

const jsonNoStore = (body: unknown, init?: ResponseInit) =>
  NextResponse.json(body, {
    ...init,
    headers: {
      'Cache-Control': 'no-store',
      ...(init?.headers ?? {}),
    },
  })

const parseTsvLine = (line: string): string[] => {
  const values: string[] = []
  let value = ''
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (char === '\t' && !quoted) {
      values.push(value)
      value = ''
      continue
    }
    value += char
  }
  values.push(value)
  return values
}

const parseTsv = (text: string): Record<string, string>[] => {
  const lines = text.split(/\r?\n/).filter(Boolean)
  if (!lines.length) return []
  const headers = parseTsvLine(lines[0])
  return lines.slice(1).map((line) => {
    const values = parseTsvLine(line)
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
  })
}

const pairKey = (left: string, right: string): string =>
  [left.trim(), right.trim()].sort().join('\u0000')

const snapshotGoldPath = (snapshotRevision: string): string =>
  join(GOLD_DIR, `${snapshotRevision}.tsv`)

const pairSetForRows = (rows: Record<string, string>[]): Set<string> => {
  const result = new Set<string>()
  for (const row of rows) {
    const source = (row.source ?? '').trim()
    const target = (row.target ?? '').trim()
    if (source && target) result.add(pairKey(source, target))
  }
  return result
}

const samePairSet = (left: Set<string>, right: Set<string>): boolean =>
  left.size === right.size && [...left].every((key) => right.has(key))

const parseGoldBoolean = (value: string): boolean | undefined => {
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return undefined
}

const readTextIfExists = async (path: string): Promise<string> => {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const fetchSnapshotManifest = async (
  snapshotRevision: string,
): Promise<SnapshotManifest> => {
  if (!revisionPattern.test(snapshotRevision)) {
    throw new Error('Invalid snapshot revision')
  }

  const token = await readMemexApiToken()
  const response = await fetch(
    `${HEDGEDOC_NOTES_API}/${encodeURIComponent(SNAPSHOTS_ALIAS)}/revisions/${encodeURIComponent(snapshotRevision)}`,
    {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` },
    },
  )
  if (!response.ok) {
    throw new Error(`HedgeDoc snapshot revision request failed (${response.status})`)
  }

  const revision = (await response.json()) as { content?: string }
  if (typeof revision.content !== 'string') {
    throw new Error('Selected HedgeDoc snapshot revision has no content')
  }

  const match = revision.content.match(
    /## Source Manifest[\s\S]*?```json\s*([\s\S]*?)```/i,
  )
  if (!match) {
    throw new Error('Selected revision does not contain a Source Manifest')
  }

  const manifest = JSON.parse(match[1]) as SnapshotManifest
  if (!Array.isArray(manifest.sources) || manifest.sources.length < 2) {
    throw new Error('Selected snapshot contains fewer than two sources')
  }
  return manifest
}

const goldStatus = async (snapshotRevision: string) => {
  const manifest = await fetchSnapshotManifest(snapshotRevision)
  const aliases = (manifest.sources ?? [])
    .map((source) => (source.alias ?? '').trim())
    .filter(Boolean)
  const expected = new Set<string>()
  for (let left = 0; left < aliases.length; left += 1) {
    for (let right = left + 1; right < aliases.length; right += 1) {
      expected.add(pairKey(aliases[left], aliases[right]))
    }
  }

  const snapshotPath = snapshotGoldPath(snapshotRevision)
  let goldPath = snapshotPath
  let storage: 'snapshot' | 'legacy-fallback' | 'new' = 'new'
  let text = await readTextIfExists(snapshotPath)

  if (text) {
    storage = 'snapshot'
  } else {
    const legacyText = await readTextIfExists(LEGACY_GOLD_FILE)
    if (legacyText) {
      const legacyRows = parseTsv(legacyText)
      if (samePairSet(pairSetForRows(legacyRows), expected)) {
        text = legacyText
        goldPath = LEGACY_GOLD_FILE
        storage = 'legacy-fallback'
      }
    }
  }

  if (!text) {
    return {
      exists: false,
      ready: false,
      pairsExpected: expected.size,
      pairsPresent: 0,
      pairsLabeled: 0,
      unlabeled: expected.size,
      invalid: 0,
      missing: expected.size,
      extra: 0,
      path: goldPath,
      storage,
      snapshotName: manifest.name ?? '',
    }
  }

  const rows = parseTsv(text)
  const present = pairSetForRows(rows)
  let labeled = 0
  let invalid = 0
  for (const row of rows) {
    const source = (row.source ?? '').trim()
    const target = (row.target ?? '').trim()
    if (!source || !target || !expected.has(pairKey(source, target))) continue
    const parsed = parseGoldBoolean(row.gold_associated ?? '')
    if (parsed === undefined) invalid += 1
    else labeled += 1
  }

  const missing = [...expected].filter((key) => !present.has(key)).length
  const extra = [...present].filter((key) => !expected.has(key)).length
  const unlabeled = Math.max(0, expected.size - labeled)
  const ready =
    missing === 0 &&
    extra === 0 &&
    invalid === 0 &&
    present.size === expected.size &&
    labeled === expected.size

  return {
    exists: true,
    ready,
    pairsExpected: expected.size,
    pairsPresent: present.size,
    pairsLabeled: labeled,
    unlabeled,
    invalid,
    missing,
    extra,
    path: goldPath,
    storage,
    snapshotName: manifest.name ?? '',
  }
}

const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const isBenchmarkProcessAlive = async (status: StatusFile): Promise<boolean> => {
  if (!isPidAlive(status.pid)) return false
  try {
    const commandLine = await readFile(`/proc/${status.pid}/cmdline`, 'utf8')
    return commandLine.includes('association_eval.py') && commandLine.includes(status.runId)
  } catch {
    return false
  }
}

const readStatus = async (runId: string): Promise<StatusFile | undefined> => {
  const text = await readTextIfExists(join(STATUS_DIR, `${runId}.json`))
  if (!text) return undefined
  try {
    return JSON.parse(text) as StatusFile
  } catch {
    return undefined
  }
}

const loadRunState = async (runId: string) => {
  if (!runPattern.test(runId)) throw new Error('Invalid benchmark run id')

  const metricsPath = join(METRICS_DIR, `${runId}.json`)
  if (await fileExists(metricsPath)) {
    return { state: 'completed' as const, runId }
  }

  const status = await readStatus(runId)
  if (!status) return undefined
  if (await isBenchmarkProcessAlive(status)) {
    return {
      state: 'running' as const,
      runId,
      pid: status.pid,
      startedAt: status.startedAt,
      snapshotRevision: status.snapshotRevision,
    }
  }

  const log = await readTextIfExists(status.logFile)
  return {
    state: 'failed' as const,
    runId,
    startedAt: status.startedAt,
    snapshotRevision: status.snapshotRevision,
    logTail: log.slice(-5000),
  }
}

const findActiveRun = async (snapshotRevision?: string) => {
  let names: string[] = []
  try {
    names = (await readdir(STATUS_DIR)).filter((name) => name.endsWith('.json')).sort().reverse()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  for (const name of names) {
    const runId = basename(name, '.json')
    if (!runPattern.test(runId)) continue
    const status = await readStatus(runId)
    if (!status || (snapshotRevision && status.snapshotRevision !== snapshotRevision)) continue
    if (await fileExists(join(METRICS_DIR, `${runId}.json`))) continue
    if (await isBenchmarkProcessAlive(status)) {
      return {
        runId,
        pid: status.pid,
        startedAt: status.startedAt,
        snapshotRevision: status.snapshotRevision,
      }
    }
  }
  return undefined
}

const discoverModels = async (baseUrl: string): Promise<string[]> => {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return []
    const body = (await response.json()) as {
      models?: Array<{ name?: string; model?: string }>
    }
    return (body.models ?? [])
      .map((item) => (item.name ?? item.model ?? '').trim())
      .filter((model) => modelPattern.test(model))
  } catch {
    return []
  }
}

const makeRunId = (): string => {
  const now = new Date()
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace(/\.\d{3}Z$/, '')
  return `${stamp}-${randomUUID().slice(0, 6)}`
}

const validateModel = (value: unknown, fallback: string): string => {
  const model = typeof value === 'string' ? value.trim() : ''
  if (!model) return fallback
  if (!modelPattern.test(model)) throw new Error('Invalid Ollama model name')
  return model
}

const intInRange = (value: unknown, fallback: number, min: number, max: number): number => {
  const number = Number(value)
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback
}

const numberInRange = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  const number = Number(value)
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback
}

export async function GET(request: NextRequest) {
  try {
    const run = request.nextUrl.searchParams.get('run')?.trim() ?? ''
    if (run) {
      const state = await loadRunState(run)
      if (!state) return jsonNoStore({ error: 'Benchmark run not found' }, { status: 404 })
      return jsonNoStore(state)
    }

    const snapshotRevision =
      request.nextUrl.searchParams.get('snapshotRevision')?.trim() ?? ''
    if (!revisionPattern.test(snapshotRevision)) {
      return jsonNoStore({ error: 'A valid snapshotRevision is required' }, { status: 400 })
    }

    const settings = await readMemexModelSettings()
    const discovered = await discoverModels(settings.baseUrl)
    const models = Array.from(
      new Set([settings.defaultModel, ...discovered].filter(Boolean)),
    ).sort()
    const [gold, activeRun] = await Promise.all([
      goldStatus(snapshotRevision),
      findActiveRun(snapshotRevision),
    ])

    return jsonNoStore({
      models,
      defaultCandidateModel: settings.defaultModel,
      defaultVerifierModel: settings.defaultModel,
      defaultBenchmarkModel: settings.defaultModel,
      defaultEvaluationScope: 'quick',
      quickMaxPairs: 40,
      defaultNumCtx: settings.numCtx,
      defaultTemperature: settings.temperature,
      defaultConfidenceThreshold: 0.85,
      gold,
      activeRun,
    })
  } catch (error) {
    return jsonNoStore(
      { error: error instanceof Error ? error.message : 'Unable to prepare benchmark run' },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>
    const snapshotRevision =
      typeof body.snapshotRevision === 'string' ? body.snapshotRevision.trim() : ''
    if (!revisionPattern.test(snapshotRevision)) {
      return jsonNoStore({ error: 'A valid snapshotRevision is required' }, { status: 400 })
    }

    const existing = await findActiveRun()
    if (existing) {
      return jsonNoStore(
        {
          error: `Benchmark ${existing.runId} is already running. Wait for it to finish before starting another.`,
          activeRun: existing,
        },
        { status: 409 },
      )
    }

    const gold = await goldStatus(snapshotRevision)
    if (!gold.ready) {
      return jsonNoStore(
        {
          error: `Gold set is not ready: ${gold.pairsLabeled}/${gold.pairsExpected} pairs labeled, ${gold.missing} missing, ${gold.extra} extra, ${gold.invalid} invalid.`,
          gold,
        },
        { status: 409 },
      )
    }

    const settings = await readMemexModelSettings()
    const benchmarkModel = validateModel(
      body.benchmarkModel ?? body.verifierModel ?? body.candidateModel,
      settings.defaultModel,
    )
    // Benchmarks now default to one-model direct verification. This removes the
    // candidate/verifier double-call from model screening while retaining the
    // historical metric fields for compatibility.
    const candidateModel = benchmarkModel
    const verifierModel = benchmarkModel
    const mode = 'verifier' as const
    const evaluationScope = body.evaluationScope === 'full' ? 'full' : 'quick'
    const maxPairs = evaluationScope === 'quick' ? 40 : 0
    const numCtx = intInRange(body.numCtx, settings.numCtx, 1024, 1048576)
    const temperature = numberInRange(body.temperature, settings.temperature, 0, 2)
    const confidenceThreshold = numberInRange(
      body.confidenceThreshold,
      0.85,
      0,
      1,
    )

    await stat(EVALUATOR)
    await Promise.all([
      mkdir(RESULTS_DIR, { recursive: true }),
      mkdir(METRICS_DIR, { recursive: true }),
      mkdir(STATUS_DIR, { recursive: true }),
      mkdir(LOG_DIR, { recursive: true }),
    ])

    const runId = makeRunId()
    const resultsFile = join(RESULTS_DIR, `${runId}.tsv`)
    const metricsFile = join(METRICS_DIR, `${runId}.json`)
    const logFile = join(LOG_DIR, `${runId}.log`)
    const logHandle = await open(logFile, 'a')
    let child
    try {
      child = spawn(
        PYTHON,
        [
          EVALUATOR,
          '--snapshot-revision',
          snapshotRevision,
          '--gold-file',
          gold.path,
          '--results-file',
          resultsFile,
          '--metrics-file',
          metricsFile,
          '--runs-markdown',
          RUNS_MD,
          '--candidate-model',
          candidateModel,
          '--verifier-model',
          verifierModel,
          '--mode',
          mode,
          '--run-id',
          runId,
          '--num-ctx',
          String(numCtx),
          '--temperature',
          String(temperature),
          '--confidence-threshold',
          String(confidenceThreshold),
          '--max-pairs',
          String(maxPairs),
          '--prompt-version',
          'association-benchmark-ui-v2-simple',
        ],
        {
          cwd: PROJECT_ROOT,
          detached: true,
          env: process.env,
          stdio: ['ignore', logHandle.fd, logHandle.fd],
        },
      )
    } finally {
      await logHandle.close()
    }

    if (!child.pid) {
      throw new Error('Unable to start benchmark evaluator process')
    }

    const status: StatusFile = {
      runId,
      pid: child.pid,
      snapshotRevision,
      candidateModel,
      verifierModel,
      mode,
      evaluationScope,
      maxPairs,
      startedAt: new Date().toISOString(),
      logFile,
    }
    await writeFile(join(STATUS_DIR, `${runId}.json`), `${JSON.stringify(status, null, 2)}\n`, 'utf8')
    child.unref()

    return jsonNoStore(
      {
        state: 'running',
        runId,
        pid: child.pid,
        startedAt: status.startedAt,
        snapshotRevision,
      },
      { status: 202 },
    )
  } catch (error) {
    return jsonNoStore(
      { error: error instanceof Error ? error.message : 'Unable to start benchmark run' },
      { status: 500 },
    )
  }
}
