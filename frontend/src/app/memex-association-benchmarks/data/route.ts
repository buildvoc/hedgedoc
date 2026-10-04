import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROOT =
  process.env.MEMEX_ASSOCIATION_BENCHMARK_PATH ??
  '/data/projects/hedgedoc/memex/benchmarks/association'
const METRICS_DIR = join(ROOT, 'metrics')
const RESULTS_DIR = join(ROOT, 'results')
const RUNS_MD = join(ROOT, 'BenchmarkRuns.md')
const runPattern = /^[A-Za-z0-9_.:+@-]{1,180}$/

interface BenchmarkMetric {
  Run: string
  Created_at?: string
  Snapshot_name?: string
  Snapshot_revision?: string
  Snapshot_source_count?: number
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
  Specificity_assoc_avg?: number
  False_positive_rate?: number
  Candidate_recall?: number
  True_positives?: number
  True_negatives?: number
  False_positives?: number
  False_negatives?: number
  Scoring_method?: string
  Thresholded_precision_assoc_avg?: number
  Thresholded_recall_assoc_avg?: number
  Thresholded_f1_score_assoc_avg?: number
  Thresholded_false_positives?: number
  Thresholded_false_negatives?: number
  Pairs_evaluated?: number
  Average_confidence_correct?: number
  Average_confidence_wrong?: number
  Elapsed_seconds?: number
  Results_file?: string
  [key: string]: unknown
}

const safeRead = async (path: string): Promise<string> => {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

const parseRunsMarkdown = (text: string): Record<string, Record<string, string>> => {
  const rows: Record<string, Record<string, string>> = {}
  let current = ''

  for (const raw of text.split(/\r?\n/)) {
    const heading = raw.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      current = heading[1].trim()
      rows[current] = rows[current] ?? {}
      continue
    }
    if (!current) continue
    const field = raw.match(/^([^=]+?)\s*=\s*(.*?)\s{0,2}$/)
    if (!field) continue
    rows[current][field[1].trim()] = field[2].trim()
  }

  return rows
}

const loadMetrics = async (): Promise<BenchmarkMetric[]> => {
  let names: string[] = []
  try {
    names = (await readdir(METRICS_DIR))
      .filter((name) => name.endsWith('.json'))
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const metrics: BenchmarkMetric[] = []
  for (const name of names) {
    const parsed = JSON.parse(await readFile(join(METRICS_DIR, name), 'utf8')) as BenchmarkMetric
    const fallbackRun = basename(name, '.json')
    parsed.Run = String(parsed.Run || fallbackRun)
    if (!runPattern.test(parsed.Run)) continue
    metrics.push(parsed)
  }

  metrics.sort((left, right) =>
    String(left.Created_at ?? left.Run).localeCompare(String(right.Created_at ?? right.Run)),
  )
  return metrics
}

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

const parseBoolean = (value: unknown): boolean | undefined => {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return undefined
}

const associationOutcome = (gold: boolean, predicted: boolean): string => {
  if (gold && predicted) return 'true_positive'
  if (!gold && !predicted) return 'true_negative'
  if (!gold && predicted) return 'false_positive'
  return 'false_negative'
}

const safeDivide = (numerator: number, denominator: number): number =>
  denominator ? numerator / denominator : 0

const resultsFileName = (metric: BenchmarkMetric): string => {
  const explicitResults =
    typeof metric.Results_file === 'string' ? basename(metric.Results_file) : ''
  return explicitResults && explicitResults.endsWith('.tsv')
    ? explicitResults
    : `${metric.Run}.tsv`
}

const decisionScoreMetric = async (metric: BenchmarkMetric): Promise<BenchmarkMetric> => {
  const text = await safeRead(join(RESULTS_DIR, resultsFileName(metric)))
  const rows = parseTsv(text)
  if (!rows.length) return metric

  let tp = 0
  let tn = 0
  let fp = 0
  let fn = 0
  let scored = 0

  for (const row of rows) {
    const gold = parseBoolean(row.gold_associated)
    const predicted = parseBoolean(row.verifier_associated)
    if (gold === undefined || predicted === undefined) continue
    scored += 1
    const result = associationOutcome(gold, predicted)
    if (result === 'true_positive') tp += 1
    else if (result === 'true_negative') tn += 1
    else if (result === 'false_positive') fp += 1
    else fn += 1
  }

  if (!scored) return metric
  const precision = safeDivide(tp, tp + fp)
  const recall = safeDivide(tp, tp + fn)
  const f1 = safeDivide(2 * precision * recall, precision + recall)
  const fpr = safeDivide(fp, fp + tn)

  return {
    ...metric,
    Thresholded_precision_assoc_avg: metric.Precision_assoc_avg,
    Thresholded_recall_assoc_avg: metric.Recall_assoc_avg,
    Thresholded_f1_score_assoc_avg: metric.F1_score_assoc_avg,
    Thresholded_false_positives: metric.False_positives,
    Thresholded_false_negatives: metric.False_negatives,
    Precision_assoc_avg: precision,
    Recall_assoc_avg: recall,
    F1_score_assoc_avg: f1,
    False_positive_rate: fpr,
    True_positives: tp,
    True_negatives: tn,
    False_positives: fp,
    False_negatives: fn,
    Pairs_evaluated: scored,
    Scoring_method: 'model-decision',
  }
}

const decisionScoreRows = (rows: Record<string, string>[]): Record<string, string>[] =>
  rows.map((row) => {
    const gold = parseBoolean(row.gold_associated)
    const predicted = parseBoolean(row.verifier_associated)
    if (gold === undefined || predicted === undefined) return row
    return {
      ...row,
      thresholded_predicted_associated: row.predicted_associated ?? '',
      thresholded_outcome: row.outcome ?? '',
      predicted_associated: String(predicted),
      outcome: associationOutcome(gold, predicted),
    }
  })

export async function GET(request: NextRequest) {
  try {
    const run = request.nextUrl.searchParams.get('run')?.trim() ?? ''
    const [storedMetrics, markdown] = await Promise.all([
      loadMetrics(),
      safeRead(RUNS_MD),
    ])
    const metrics = await Promise.all(storedMetrics.map(decisionScoreMetric))
    const metadata = parseRunsMarkdown(markdown)
    const runs = metrics.map((metric) => ({
      ...metric,
      metadata: metadata[metric.Run] ?? {},
    }))

    if (!run) {
      return NextResponse.json(
        { runs },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }

    if (!runPattern.test(run)) {
      return NextResponse.json({ error: 'Invalid benchmark run id' }, { status: 400 })
    }

    const metric = runs.find((item) => item.Run === run)
    if (!metric) {
      return NextResponse.json({ error: 'Benchmark run not found' }, { status: 404 })
    }

    const resultName = resultsFileName(metric)
    const results = decisionScoreRows(
      parseTsv(await safeRead(join(RESULTS_DIR, resultName))),
    )

    return NextResponse.json(
      { run: metric, results },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to read association benchmark data',
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
