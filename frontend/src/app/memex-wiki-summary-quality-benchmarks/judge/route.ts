import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { readMemexModelSettings } from '../../memex-model-settings/_settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const ROOT = process.env.MEMEX_PROJECT_ROOT ?? '/data/projects/hedgedoc'
const RUNS = process.env.MEMEX_WIKI_BENCHMARK_RUN_DIR ?? join(ROOT, 'memex/benchmarks/summary/runs')
const GOLD = process.env.MEMEX_WIKI_BENCHMARK_GOLD_DIR ?? join(ROOT, 'memex/benchmarks/summary/gold')
const JUDGED = process.env.MEMEX_WIKI_BENCHMARK_JUDGE_DIR ?? join(ROOT, 'memex/benchmarks/summary/judged')
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i
const respond = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
type Fact = { id: string; expectation: string }
type Row = { id: string; prediction: 'supported' | 'partial' | 'missing' | 'incorrect'; confidence: number; reason: string; evidence: string }
type Run = { runId: string; snapshotRevision: string; summary: string; model: string; source: { alias: string; revisionId: string }; goldReferenceRevision: string; goldReferenceAlias?: string }
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
      const runs = [] as Array<{runId:string; createdAt:string; model:string; judged:boolean; referenceAlias?:string; sourceAlias:string}>
      for (const name of names.slice(-500)) {
        try {
          const run = JSON.parse(await readFile(join(RUNS, name),'utf8')) as Run & { createdAt?: string }
          if (run.snapshotRevision !== snapshotRevision || run.runId !== name.slice(0,-5)) continue
          runs.push({ runId: run.runId, createdAt: run.createdAt || '', model: run.model, referenceAlias: run.goldReferenceAlias, sourceAlias: run.source.alias, judged: Boolean(await existing(run.runId)) })
        } catch { continue }
      }
      return respond({ runs: runs.reverse() })
    }
    const { run, gold } = await load(runId)
    if (snapshotRevision && run.snapshotRevision !== snapshotRevision) throw new Error('Run does not belong to selected snapshot')
    return respond({ run: { runId: run.runId, summary: run.summary, model: run.model }, facts: gold.facts, result: await existing(runId) })
  } catch (e) { return respond({ error: String(e) }, 400) }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { runId?: unknown }
    const runId = typeof body.runId === 'string' ? body.runId : ''
    const { run, gold } = await load(runId)
    const previous = await existing(runId)
    if (previous) return respond({ result: previous, reused: true })
    const settings = await readMemexModelSettings()
    const system = 'Evaluate factual coverage of a frozen summary against human-approved Gold expectations. These are MODEL-ASSESSED and UNVERIFIED judgements, not proof of compliance. For EVERY Gold fact ID, return one JSON row IN THE SAME ORDER: {"id":"exact input ID","prediction":"supported|partial|missing|incorrect","confidence":85,"reason":"concise rationale","evidence":"short EXACT contiguous quote from SUMMARY or empty string"}. Confidence MUST be a numeric percentage 0-100. Use supported only when the summary states the expectation, partial if incompletely covered, missing if absent, incorrect for contradictions. Return ONLY JSON: {"rows":[...]}. Do not rename IDs or invent evidence quotes.'

    const url = settings.provider === 'llamacpp' ? `${settings.baseUrl.replace(/\/$/, '')}/chat/completions` : `${settings.baseUrl.replace(/\/$/, '')}/api/chat`
    // A long model reasoning trace may exhaust max_tokens without producing
    // JSON in message.content. Never mistake this for a valid Gold assessment.
    class IncompleteJudgeResponse extends Error {}
    const queryModel = async (repair: string, payload: string, maxTokens: number): Promise<string> => {
      const messages = [{ role: 'system', content: system + (repair ? ` Previous response failed validation: ${repair}. Return only the required JSON.` : '') }, { role: 'user', content: payload }]
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

    // Preserve the validated v4 row checks, but adapt the number of facts per
    // request when a Gemma/llama.cpp completion is empty, truncated or invalid.
    // Do not save ANY rows unless every Gold fact has been assessed.
    const assessBatch = async (start: number, end: number): Promise<ReturnType<typeof judgeRows>> => {
      const batch: Gold = { ...gold, facts: gold.facts.slice(start, end) }
      const payload = JSON.stringify({ summary: run.summary, goldFacts: batch.facts })
      if (payload.length > settings.maxPromptChars) {
        throw new Error(`Gold rows ${start + 1}-${end}: judging prompt exceeds shared maxPromptChars (${payload.length} > ${settings.maxPromptChars})`)
      }
      let failure = ''
      const attempts = end - start === 1 ? 2 : 1
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const raw = await queryModel(failure, payload, attempt ? 8192 : 4096)
          return judgeRows(raw, batch, run.summary)
        } catch (error) {
          // Abort, HTTP failures and configuration errors need operator action,
          // not additional model calls.
          if (!(error instanceof IncompleteJudgeResponse) &&
              !(error instanceof Error && /^(Judge |Gold fact)/.test(error.message))) throw error
          failure = error instanceof Error ? error.message : String(error)
        }
      }
      if (end - start === 1) {
        throw new Error(`Gold row ${start + 1} (${batch.facts[0].id}): ${failure}; no judgement saved`)
      }
      const midpoint = start + Math.floor((end - start) / 2)
      const left = await assessBatch(start, midpoint)
      const right = await assessBatch(midpoint, end)
      return [...left, ...right]
    }

    const rows: ReturnType<typeof judgeRows> = []
    for (let offset = 0; offset < gold.facts.length; offset += 10) {
      rows.push(...await assessBatch(offset, Math.min(offset + 10, gold.facts.length)))
    }
    if (rows.length !== gold.facts.length) throw new Error('Judge failed to assess every Gold fact; result not saved')
    const tp = rows.filter(r => r.prediction === 'supported').length
    const fn = rows.filter(r => r.prediction === 'missing').length
    const partial = rows.filter(r => r.prediction === 'partial').length
    const incorrect = rows.filter(r => r.prediction === 'incorrect').length
    // This is GOLD COVERAGE ONLY, not claim-level precision or overall factual F1.
    const record = { schemaVersion: 1, runId, snapshotRevision: run.snapshotRevision, model: settings.defaultModel,
      evaluatedAt: new Date().toISOString(), rows, goldCoverage: { supported: tp, missing: fn, partial, incorrect, total: rows.length, strictRecall: tp / rows.length }, status: 'model-assessed-unverified' }
    await mkdir(JUDGED, { recursive: true })
    try { await writeFile(join(JUDGED, `${runId}.json`), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o640 }) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return respond({ result: await existing(runId), reused: true }); throw e }
    return respond({ result: record })
  } catch (e) { return respond({ error: e instanceof Error ? e.message : String(e) }, 400) }
}
