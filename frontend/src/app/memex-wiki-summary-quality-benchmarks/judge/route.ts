import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { readMemexModelSettings } from '../../memex-model-settings/_settings'
import { readMemexApiToken } from '../../memex-revisions/_proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const ROOT = process.env.MEMEX_PROJECT_ROOT ?? '/data/projects/hedgedoc'
const RUNS = process.env.MEMEX_WIKI_BENCHMARK_RUN_DIR ?? join(ROOT, 'memex/benchmarks/summary/runs')
const GOLD = process.env.MEMEX_WIKI_BENCHMARK_GOLD_DIR ?? join(ROOT, 'memex/benchmarks/summary/gold')
const JUDGED = process.env.MEMEX_WIKI_BENCHMARK_JUDGE_DIR ?? join(ROOT, 'memex/benchmarks/summary/judged')
const NOTES = process.env.HEDGEDOC_NOTES_API ?? 'http://127.0.0.1:3100/api/v2/notes'
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i
const respond = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
type Fact = { id: string; expectation: string }
type Row = { id: string; prediction: 'supported' | 'partial' | 'missing' | 'incorrect'; confidence: number; reason: string; evidence: string }
type Run = { runId: string; snapshotRevision: string; summary: string; model: string; source: { alias: string; revisionId: string }; goldReferenceRevision: string; goldReferenceAlias?: string; summaryMode?: 'existing' | 'generated'; sourceSummary?: { alias: string; revisionId: string; title: string; generatorModel: string }; createdAt?: string }
type Gold = { snapshotRevision: string; facts: Fact[]; reviewer: string; source: { alias: string; revisionId: string }; reference: { revisionId: string; alias?: string } }
const outcome = (p: Row['prediction']) => p === 'supported' ? 'True positive' : p === 'missing' ? 'False negative' : p === 'partial' ? 'Partial' : 'Incorrect'

// Treat the judge response as untrusted model output. Correct harmless formatting
// differences, but never invent a fact ID, a prediction, or a supporting quote.
function judgeRows(raw: string, gold: Gold, summary: string): Array<Row & { outcome: string; evidenceValidation?: string }> {
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const unfenced = withoutThink.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  let decoded: unknown
  try {
    decoded = JSON.parse(unfenced) as unknown
  } catch {
    const first = unfenced.indexOf('{')
    const last = unfenced.lastIndexOf('}')
    if (first < 0 || last <= first) throw new Error('Judge did not return a JSON object')
    try { decoded = JSON.parse(unfenced.slice(first, last + 1)) as unknown }
    catch { throw new Error('Judge returned malformed JSON') }
  }
  const container = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
    ? decoded as Record<string, unknown> : null
  const candidate = Array.isArray(decoded) ? decoded : (container?.rows ?? container?.results)
  if (!Array.isArray(candidate)) throw new Error('Judge JSON has no rows array')
  if (candidate.length !== gold.facts.length) {
    throw new Error(`Judge returned ${candidate.length} rows; expected ${gold.facts.length}`)
  }
  const factIds = new Map(gold.facts.map(f => [f.id.toLowerCase(), f.id]))
  const seen = new Set<string>()
  const rows = candidate.map((item: unknown, index: number) => {
    const ordinal = index + 1
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Judge row ${ordinal} is not an object`)
    }
    const entry = item as Record<string, unknown>
    const suppliedId = typeof entry.id === 'string' || typeof entry.id === 'number'
      ? String(entry.id).trim() : ''
    const id = factIds.get(suppliedId.toLowerCase())
    if (!id || seen.has(id)) {
      throw new Error(`Judge row ${ordinal} has unknown or duplicate Gold fact ID ${JSON.stringify(suppliedId)}`)
    }
    seen.add(id)
    const label = typeof entry.prediction === 'string'
      ? entry.prediction.toLowerCase().trim().replace(/[\s_-]+/g, ' ') : ''
    const predictions: Record<string, Row['prediction']> = {
      supported: 'supported', 'fully supported': 'supported', present: 'supported',
      partial: 'partial', 'partially supported': 'partial', 'partially present': 'partial',
      missing: 'missing', absent: 'missing', 'not mentioned': 'missing',
      'not present': 'missing', 'not covered': 'missing',
      incorrect: 'incorrect', contradicted: 'incorrect', contradiction: 'incorrect',
    }
    const prediction = predictions[label]
    if (!prediction) throw new Error(`Judge row ${ordinal} has unsupported prediction ${JSON.stringify(entry.prediction)}`)
    const confidenceText = typeof entry.confidence === 'number' || typeof entry.confidence === 'string'
      ? String(entry.confidence).trim() : ''
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)\s*%?$/.test(confidenceText)) {
      throw new Error(`Judge row ${ordinal} has nonnumeric confidence ${JSON.stringify(entry.confidence)}`)
    }
    let confidence = Number(confidenceText.replace('%', '').trim())
    // Some providers return probabilities even when instructed to use 0-100.
    if (confidence > 0 && confidence < 1 && !confidenceText.includes('%')) confidence *= 100
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
      throw new Error(`Judge row ${ordinal} confidence is outside 0-100`)
    }
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : ''
    if (!reason || reason.length > 4000) {
      throw new Error(`Judge row ${ordinal} has no usable reason`)
    }
    const submittedEvidence = typeof entry.evidence === 'string' ? entry.evidence.trim() : ''
    const unquotedEvidence = submittedEvidence.replace(/^["'`“”]+|["'`“”]+$/g, '')
    const verifiedEvidence = [submittedEvidence, unquotedEvidence].find(value => value && summary.includes(value)) || ''
    // Do not reject an otherwise useful judgement because the model provided
    // a paraphrase in its evidence field. Never persist that paraphrase as a quote.
    const evidenceValidation = submittedEvidence && !verifiedEvidence ? 'non-verbatim-quote-omitted' : undefined
    return { id, prediction, confidence, reason, evidence: verifiedEvidence,
      outcome: outcome(prediction), ...(evidenceValidation ? { evidenceValidation } : {}) }
  })
  return rows
}
async function load(runId: string) {
  if (!RUN_ID.test(runId)) throw new Error('Invalid run ID')
  const run = JSON.parse(await readFile(join(RUNS, `${runId}.json`), 'utf8')) as Run
  if (run.runId !== runId || !run.snapshotRevision || !run.summary?.trim()) throw new Error('Invalid frozen benchmark run')
  const names = run.goldReferenceAlias
    ? [`${run.snapshotRevision}--${run.goldReferenceAlias}.json`, `${run.snapshotRevision}.json`]
    : [`${run.snapshotRevision}.json`]
  let gold: Gold | undefined
  for (const name of names) {
    try {
      const candidate = JSON.parse(await readFile(join(GOLD, name), 'utf8')) as Gold
      if (!run.goldReferenceAlias || candidate.reference?.alias === run.goldReferenceAlias) {
        gold = candidate; break
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
  if (!gold) throw new Error('Approved Gold Set for selected source/Gold pair not found')
  if (gold.snapshotRevision !== run.snapshotRevision || !gold.reviewer || !gold.facts?.length ||
      gold.source.alias !== run.source.alias || gold.source.revisionId !== run.source.revisionId ||
      gold.reference.revisionId !== run.goldReferenceRevision) throw new Error('Run and approved Gold Set do not match')
  return { run, gold }
}
async function existing(runId: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(join(JUDGED, `${runId}.json`), 'utf8')) as unknown }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
}
export async function GET(req: NextRequest) {
  try {
    const snapshotRevision = req.nextUrl.searchParams.get('snapshotRevision') || ''
    const runId = req.nextUrl.searchParams.get('runId') || ''
    if (!runId) {
      if (!/^[0-9a-f-]{16,64}$/i.test(snapshotRevision)) throw new Error('Invalid snapshot revision')
      const { readdir } = await import('node:fs/promises')
      let names: string[] = []
      try { names = (await readdir(RUNS)).filter(n => /^[0-9a-f-]{36}\.json$/i.test(n)) }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      const runs = [] as Array<{runId:string; createdAt:string; model:string; judged:boolean; referenceAlias?:string; sourceAlias:string; summaryMode?:string; sourceSummaryAlias?:string; sourceSummaryRevision?:string; judgeModel?:string; runtimeMs?:number}>
      for (const name of names.slice(-500)) {
        try {
          const run = JSON.parse(await readFile(join(RUNS, name),'utf8')) as Run & { createdAt?: string }
          if (run.snapshotRevision !== snapshotRevision || run.runId !== name.slice(0,-5)) continue
          const scored = await existing(run.runId) as { judgeModel?: string; runtimeMs?: number } | null
          runs.push({ runId: run.runId, createdAt: run.createdAt || '', model: run.model,
            referenceAlias: run.goldReferenceAlias, sourceAlias: run.source.alias, judged: Boolean(scored),
            summaryMode: run.summaryMode || 'generated', sourceSummaryAlias: run.sourceSummary?.alias,
            sourceSummaryRevision: run.sourceSummary?.revisionId,
            judgeModel: scored?.judgeModel, runtimeMs: scored?.runtimeMs })
        } catch { continue }
      }
      return respond({ runs: runs.reverse() })
    }
    const { run, gold } = await load(runId)
    if (snapshotRevision && run.snapshotRevision !== snapshotRevision) throw new Error('Run does not belong to selected snapshot')
    return respond({ run: { runId: run.runId, summary: run.summary, model: run.model, summaryMode: run.summaryMode || 'generated', sourceSummary: run.sourceSummary, source: run.source, createdAt: run.createdAt, goldReferenceAlias: gold.reference.alias }, facts: gold.facts, result: await existing(runId) })
  } catch (e) { return respond({ error: String(e) }, 400) }
}
// A single model-decision pass: every request evaluates its Gold fact and a
// bounded, non-overlapping set of summary statements against the frozen source.
// No second claim-extraction model workflow or audit endpoint.
type ClaimDecision = { claim: string; supported: boolean; confidence: number; reason: string }
type CombinedRow = { gold: ReturnType<typeof judgeRows>[number]; claims: ClaimDecision[] }
type CombinedCheckpoint = { version: 2; runId: string; statements: string[]; rows: CombinedRow[] }
function atomicJson(path: string, value: unknown) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  return writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o640 }).then(() => rename(tmp, path))
}
function parseModelJson(raw: string): Record<string, unknown> {
  const clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const start = clean.indexOf('{'), end = clean.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('Model returned no JSON object')
  try {
    const obj = JSON.parse(clean.slice(start, end + 1)) as unknown
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Invalid JSON')
    return obj as Record<string, unknown>
  } catch { throw new Error('Model returned malformed JSON') }
}
function summaryStatements(summary: string): string[] {
  // Keep the coverage inventory deterministic and unchanged on retry.
  return summary.split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.replace(/^\s*(?:[-*#>]+|\d+[.)])\s*/, '').trim())
    .filter(s => s.length >= 15)
    .flatMap(s => s.length <= 450 ? [s] : (s.match(/[\s\S]{1,450}/g) ?? []))
}
function parseCombined(raw: string, gold: Gold, summary: string, statements: string[]): CombinedRow {
  const obj = parseModelJson(raw)
  const rows = judgeRows(JSON.stringify({ rows: obj.rows }), gold, summary)
  if (rows.length !== 1 || !Array.isArray(obj.claimDecisions) || obj.claimDecisions.length !== statements.length) {
    throw new Error('Judge returned incomplete combined decisions')
  }
  const decisions: ClaimDecision[] = obj.claimDecisions.map((v, i) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid claim decision')
    const d = v as Record<string, unknown>
    const confidence = Number(d.confidence)
    if (d.claim !== statements[i] || typeof d.supported !== 'boolean' ||
        !Number.isFinite(confidence) || confidence < 0 || confidence > 100 ||
        typeof d.reason !== 'string' || !d.reason.trim()) throw new Error('Invalid or unaligned claim decision')
    return { claim: statements[i], supported: d.supported, confidence, reason: d.reason.slice(0, 400) }
  })
  return { gold: rows[0], claims: decisions }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { runId?: unknown }
    const runId = typeof body.runId === 'string' ? body.runId : ''
    const { run, gold } = await load(runId)
    const previous = await existing(runId)
    if (previous) return respond({ result: previous, reused: true })
    const startedAt = Date.now()
    const settings = await readMemexModelSettings()
    const system = 'Make independent BINARY model decisions in ONE response. Assess the Gold fact against the summary: supported, partial, missing or incorrect. Then assess EACH supplied summary statement against the frozen ORIGINAL as a binary supported true/false (false for uncertain, partial, contradictory or invented). Return JSON ONLY: {"rows":[{"id":"exact Gold fact ID","prediction":"supported","confidence":85,"reason":"brief","evidence":""}],"claimDecisions":[{"claim":"exact supplied statement","supported":true,"confidence":85,"reason":"brief"}]}. Preserve claim text and order exactly, no extra decisions. Confidence 0-100.'
    const token = await readMemexApiToken()
    const sourceResponse = await fetch(`${NOTES}/${encodeURIComponent(run.source.alias)}/revisions/${encodeURIComponent(run.source.revisionId)}`,
      { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
    if (!sourceResponse.ok) throw new Error(`Frozen original unavailable (HTTP ${sourceResponse.status})`)
    const originalBody = await sourceResponse.json() as { content?: unknown }
    const original = typeof originalBody.content === 'string' ? originalBody.content : ''
    if (!original.trim()) throw new Error('Frozen original is empty')
    const statements = summaryStatements(run.summary)
    if (!statements.length) throw new Error('Summary contains no assessable statements; precision undefined')
    // Preserve each successful Gold+claim decision atomically to resume safely.
    await mkdir(JUDGED, { recursive: true })
    const checkpointPath = join(JUDGED, `${runId}.combined-checkpoint.json`)
    let checkpoint: CombinedCheckpoint
    try { checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as CombinedCheckpoint }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      checkpoint = { version: 2, runId, statements, rows: [] }
      await atomicJson(checkpointPath, checkpoint)
    }
    if (checkpoint.version !== 2 || checkpoint.runId !== runId ||
        JSON.stringify(checkpoint.statements) !== JSON.stringify(statements) ||
        !Array.isArray(checkpoint.rows) || checkpoint.rows.length > gold.facts.length) {
      throw new Error('Combined checkpoint mismatch; existing data preserved')
    }


    const url = settings.provider === 'llamacpp' ? `${settings.baseUrl.replace(/\/$/, '')}/chat/completions` : `${settings.baseUrl.replace(/\/$/, '')}/api/chat`
    // A long model reasoning trace may exhaust max_tokens without producing
    // JSON in message.content. Never mistake this for a valid Gold assessment.
    class IncompleteJudgeResponse extends Error {}
    const queryModel = async (repair: string, payload: string, maxTokens: number, systemText = system): Promise<string> => {
      const messages = [{ role: 'system', content: systemText + (repair ? ` Previous response failed validation: ${repair}. Return only the required JSON.` : '') }, { role: 'user', content: payload }]
      const ctl = new AbortController()
      const timeout = setTimeout(() => ctl.abort(), settings.timeoutSeconds * 1000)
      let response: Response
      try {
        response = await fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings.provider === 'llamacpp'
          ? { model: settings.defaultModel, messages, temperature: 0, max_tokens: maxTokens, stream: false }
          : { model: settings.defaultModel, messages, stream: false, options: { temperature: 0, num_ctx: settings.numCtx, num_predict: maxTokens } }) })
      } finally { clearTimeout(timeout) }
      if (!response.ok) throw new Error(`Configured model HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
      const answer = await response.json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; message?: { content?: string }; done_reason?: string; usage?: { completion_tokens?: number } }
      const raw = settings.provider === 'llamacpp' ? answer.choices?.[0]?.message?.content : answer.message?.content
      const finish = settings.provider === 'llamacpp' ? answer.choices?.[0]?.finish_reason : answer.done_reason
      if (!raw?.trim() || finish === 'length') {
        const problem = !raw?.trim() ? 'empty content' : 'truncated content'
        throw new IncompleteJudgeResponse(`Judge returned ${problem} (finish=${finish || 'unknown'}, completion_tokens=${answer.usage?.completion_tokens ?? 'unknown'}, limit=${maxTokens})`)
      }
      return raw
    }

    // ONE evaluation pass: each Gold fact and its assigned summary claims
    // are judged in the same model request, with no subsequent claim audit.
    // One fact per call bounds output and allows checkpointed resumption.
    for (let i = checkpoint.rows.length; i < gold.facts.length; i++) {
      const from = Math.floor(i * statements.length / gold.facts.length)
      const to = Math.floor((i + 1) * statements.length / gold.facts.length)
      const subset = statements.slice(from, to)
      const factGold: Gold = { ...gold, facts: [gold.facts[i]] }
      const payload = JSON.stringify({ summary: run.summary, original, goldFacts: factGold.facts, summaryStatements: subset })
      if (payload.length > settings.maxPromptChars) throw new Error('Combined Gold/source prompt exceeds maxPromptChars')
      let decided: CombinedRow | undefined
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = await queryModel('', payload, attempt ? 16384 : 8192)
          decided = parseCombined(raw, factGold, run.summary, subset)
          break
        } catch (error) {
          if (attempt === 1) throw error
        }
      }
      if (!decided) throw new Error('Combined Gold/source decision not returned')
      checkpoint.rows.push(decided)
      await atomicJson(checkpointPath, checkpoint)
    }
    const rows = checkpoint.rows.map(r => r.gold)
    const claimDecisions = checkpoint.rows.flatMap(r => r.claims)
    if (rows.length !== gold.facts.length || claimDecisions.length !== statements.length) {
      throw new Error('Incomplete model decisions; nothing finalized')
    }
    const tp = rows.filter(r => r.prediction === 'supported').length
    const fn = rows.filter(r => r.prediction === 'missing').length
    const partial = rows.filter(r => r.prediction === 'partial').length
    const incorrect = rows.filter(r => r.prediction === 'incorrect').length
    const supportedClaims = claimDecisions.filter(d => d.supported).length
    const falsePositives = claimDecisions.length - supportedClaims
    const precision = supportedClaims / claimDecisions.length
    const recall = tp / rows.length
    const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0
    const decisionMetrics = { precision, recall, f1, truePositives: tp, falsePositives,
      falseNegatives: rows.length - tp, goldFactCount: rows.length,
      supportedClaims, verifiedClaims: claimDecisions.length,
      scoringMethod: 'model-decision' }
    const record = { schemaVersion: 1, runId, snapshotRevision: run.snapshotRevision, model: run.model,
      judgeModel: settings.defaultModel, runtimeMs: Date.now() - startedAt,
      evaluatedAt: new Date().toISOString(), rows, claimDecisions, decisionMetrics, goldCoverage: { supported: tp, missing: fn, partial, incorrect, total: rows.length, strictRecall: tp / rows.length }, status: 'model-assessed-unverified' }
    await mkdir(JUDGED, { recursive: true })
    try { await writeFile(join(JUDGED, `${runId}.json`), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o640 }) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return respond({ result: await existing(runId), reused: true }); throw e }
    return respond({ result: record })
  } catch (e) { return respond({ error: e instanceof Error ? e.message : String(e) }, 400) }
}
