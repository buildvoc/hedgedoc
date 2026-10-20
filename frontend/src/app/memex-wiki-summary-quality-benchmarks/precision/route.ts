import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { readMemexModelSettings } from '../../memex-model-settings/_settings'
import { readMemexApiToken } from '../../memex-revisions/_proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Claim-level precision is not derivable from the 161 Gold coverage rows.
// This independent audit checks the GENERATED claims against the FROZEN ORIGINAL,
// never against the Gold text. Gold remains excluded from model inputs.
const ROOT = process.env.MEMEX_PROJECT_ROOT ?? '/data/projects/hedgedoc'
const RUNS = process.env.MEMEX_WIKI_BENCHMARK_RUN_DIR ?? join(ROOT, 'memex/benchmarks/summary/runs')
const JUDGED = process.env.MEMEX_WIKI_BENCHMARK_JUDGE_DIR ?? join(ROOT, 'memex/benchmarks/summary/judged')
const AUDITS = process.env.MEMEX_WIKI_BENCHMARK_PRECISION_DIR ?? join(ROOT, 'memex/benchmarks/summary/precision')
const NOTES = process.env.HEDGEDOC_NOTES_API ?? 'http://127.0.0.1:3100/api/v2/notes'
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i
const REV = /^[a-f0-9-]{16,64}$/i
const respond = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } })

type Claim = { claim: string; quote: string }
type Verdict = Claim & { supported: boolean; confidence: number; reason: string; sourceEvidence: string }
type State = {
  schemaVersion: 1; runId: string; snapshotRevision: string; model: string
  phase: 'extract' | 'verify' | 'complete'; chunks: string[]
  extractedChunks: number; claims: Claim[]; verified: Verdict[]
  goldSupported: number; goldTotal: number; verifyBatchSize?: number; evaluatedAt?: string
}
type Run = { runId: string; snapshotRevision: string; model: string; summary: string; source: { alias: string; revisionId: string } }
type Coverage = { goldCoverage?: { supported?: number; total?: number } }
const fileFor = (id: string) => join(AUDITS, `${id}.json`)

async function jsonFile<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
}
async function validatedRun(id: string) {
  if (!RUN_ID.test(id)) throw new Error('Invalid runId')
  const run = await jsonFile<Run>(join(RUNS, `${id}.json`))
  if (!run || run.runId !== id || !REV.test(run.snapshotRevision) ||
      !run.source || !run.source.alias || !REV.test(run.source.revisionId) ||
      !run.summary?.trim()) throw new Error('Frozen run missing or invalid')
  const judged = await jsonFile<Coverage>(join(JUDGED, `${id}.json`))
  const supported = judged?.goldCoverage?.supported
  const total = judged?.goldCoverage?.total
  if (typeof supported !== 'number' || typeof total !== 'number' ||
      !Number.isInteger(supported) || !Number.isInteger(total) ||
      total <= 0 || supported < 0 || supported > total) {
    throw new Error('Evaluate and save all Gold facts before auditing precision')
  }
  return { run, supported, total }
}
async function saveState(state: State) {
  await mkdir(AUDITS, { recursive: true })
  const target = fileFor(state.runId)
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o640 })
  try { await rename(tmp, target) } finally { await rm(tmp, { force: true }) }
}
function chunksOf(summary: string): string[] {
  // Deterministically cover the COMPLETE summary, in order, without omissions.
  const text = summary.trim()
  const chunks: string[] = []
  const max = 1800
  let cursor = 0
  while (cursor < text.length) {
    let end = Math.min(cursor + max, text.length)
    if (end < text.length) {
      const part = text.slice(cursor, end)
      const delimiters = [part.lastIndexOf('\n'), part.lastIndexOf('. '), part.lastIndexOf('; ')]
      const best = Math.max(...delimiters)
      if (best > Math.floor(max * 0.6)) end = cursor + best + 1
    }
    const chunk = text.slice(cursor, end)
    if (chunk.trim()) chunks.push(chunk)
    cursor = end
  }
  return chunks
}
// A failed extraction must never silently omit any part of the generated summary.
// Replace only the current unprocessed chunk with two exact, contiguous pieces.
function splitExtractionChunk(chunk: string): [string, string] | null {
  if (chunk.length < 320) return null
  const middle = Math.floor(chunk.length / 2)
  let split = middle
  for (let i = middle; i < Math.min(chunk.length - 120, middle + 64); i++) {
    if (/\s/.test(chunk[i])) { split = i + 1; break }
  }
  const left = chunk.slice(0, split)
  const right = chunk.slice(split)
  if (!left.trim() || !right.trim() || left + right !== chunk) return null
  return [left, right]
}
function outputFailure(error: unknown): boolean {
  return error instanceof Error && /empty or truncated|model returned no JSON object|model returned malformed JSON|invalid claims array|invalid entry|missing a (?:recoverable )?verbatim quote|returned no claims|returned \d+ verdicts|source verdict|invalid source verdict|source audit returned|lacks an exact quote/i.test(error.message)
}
function parseJson(raw: string): Record<string, unknown> {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  let parsed: unknown
  try { parsed = JSON.parse(cleaned) }
  catch {
    const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('Claim audit: model returned no JSON object')
    try { parsed = JSON.parse(cleaned.slice(start, end + 1)) }
    catch { throw new Error('Claim audit: model returned malformed JSON') }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Claim audit: expected a JSON object')
  return parsed as Record<string, unknown>
}
// The generated summary is the source of the claim inventory. The model
// supplies independent factual propositions, not proof-carrying quotations.
// Evidence quotes are preserved when literally grounded but their absence
// must not stop decision-based scoring (association-benchmark parity).
function parseClaims(raw: string, chunk: string): Claim[] {
  const entries = parseJson(raw).claims
  if (!Array.isArray(entries) || entries.length > 35) throw new Error('Claim extraction returned invalid claims array')
  const claims: Claim[] = []
  for (const item of entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Claim extraction contains invalid entry')
    const entry = item as Record<string, unknown>
    const claim = typeof entry.claim === 'string' ? entry.claim.trim() : ''
    if (!claim || claim.length > 1200) throw new Error('Claim extraction contains invalid proposition')
    const suggested = typeof entry.quote === 'string' ? entry.quote.trim() : ''
    // Never manufacture a quote. Quotation evidence is diagnostic/optional;
    // generated summary text and the checkpointed chunk order remain frozen.
    const quote = suggested.length >= 8 && chunk.includes(suggested) ? suggested : ''
    claims.push({ claim, quote })
  }
  if (!claims.length && chunk.replace(/[#*\s\-\d.]/g, '').length > 35) {
    throw new Error('Claim extraction returned no claims for substantive summary text')
  }
  return claims
}
function parseVerdicts(raw: string, batch: Claim[], original: string): Verdict[] {
  const entries = parseJson(raw).verdicts
  if (!Array.isArray(entries) || entries.length !== batch.length) {
    throw new Error(`Source audit returned ${Array.isArray(entries) ? entries.length : 0} verdicts; expected ${batch.length}`)
  }
  return entries.map((value, i) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid source verdict')
    const row = value as Record<string, unknown>
    if (row.id !== i + 1 || typeof row.supported !== 'boolean') throw new Error('Source verdict ID or decision invalid')
    const confidence = typeof row.confidence === 'number' ? row.confidence : Number(row.confidence)
    const reason = typeof row.reason === 'string' ? row.reason.trim() : ''
    const quote = typeof row.sourceEvidence === 'string' ? row.sourceEvidence.trim() : ''
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100 || !reason || reason.length > 1500) {
      throw new Error('Source verdict confidence or reason invalid')
    }
    // This is an audited MODEL DECISION, as in Association Benchmarks.
    // Keep exact source evidence where available, but do not turn a valid
    // supported/unsupported decision into an extraction-format failure.
    return { ...batch[i], supported: row.supported, confidence, reason,
      sourceEvidence: quote && original.includes(quote) ? quote : '' }
  })
}
async function modelCall(
  settings: Awaited<ReturnType<typeof readMemexModelSettings>>,
  system: string, payload: object, maxOutputTokens = 4096,
): Promise<string> {
  const text = JSON.stringify(payload)
  if (text.length > settings.maxPromptChars) {
    throw new Error(`Claim audit input exceeds maxPromptChars (${text.length} > ${settings.maxPromptChars}); no result saved`)
  }
  const url = settings.provider === 'llamacpp'
    ? `${settings.baseUrl.replace(/\/$/, '')}/chat/completions`
    : `${settings.baseUrl.replace(/\/$/, '')}/api/chat`
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), settings.timeoutSeconds * 1000)
  try {
    const messages = [{ role: 'system', content: system }, { role: 'user', content: text }]
    const resp = await fetch(url, { method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings.provider === 'llamacpp'
        ? { model: settings.defaultModel, messages, temperature: 0, max_tokens: maxOutputTokens, stream: false }
        : { model: settings.defaultModel, messages, stream: false, options: { temperature: 0, num_ctx: settings.numCtx, num_predict: maxOutputTokens } }) })
    if (!resp.ok) throw new Error(`Claim audit model HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
    const answer = await resp.json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; message?: { content?: string }; done_reason?: string }
    const raw = settings.provider === 'llamacpp' ? answer.choices?.[0]?.message?.content : answer.message?.content
    const finish = settings.provider === 'llamacpp' ? answer.choices?.[0]?.finish_reason : answer.done_reason
    if (!raw?.trim() || finish === 'length') throw new Error(`Claim audit model empty or truncated (finish=${finish ?? 'unknown'}); retry to resume`)
    return raw
  } finally { clearTimeout(timer) }
}
async function originalSource(run: Run): Promise<string> {
  const token = await readMemexApiToken()
  const resp = await fetch(`${NOTES}/${encodeURIComponent(run.source.alias)}/revisions/${encodeURIComponent(run.source.revisionId)}`,
    { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
  if (!resp.ok) throw new Error(`Frozen original unavailable (HTTP ${resp.status})`)
  const body = await resp.json() as { content?: unknown }
  if (typeof body.content !== 'string' || !body.content.trim()) throw new Error('Frozen original is empty')
  return body.content
}
function progress(state: State) {
  const supportedClaims = state.verified.filter(row => row.supported).length
  const unsupportedClaims = state.verified.length - supportedClaims
  const claimCount = state.claims.length
  const precision = state.phase === 'complete' && claimCount > 0 ? supportedClaims / claimCount : null
  const recall = state.goldSupported / state.goldTotal
  const f1 = precision !== null ? (precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall)) : null
  return {
    runId: state.runId, status: state.phase, extractedChunks: state.extractedChunks,
    totalChunks: state.chunks.length, verifiedClaims: state.verified.length, totalClaims: claimCount,
    precision, recall, f1, falsePositives: state.phase === 'complete' ? unsupportedClaims : null,
    falseNegatives: state.goldTotal - state.goldSupported,
    auditedClaimCount: state.phase === 'complete' ? claimCount : null,
    model: state.model, evaluatedAt: state.evaluatedAt ?? null,
    statusLabel: 'model-assessed-unverified',
    scoringMethod: 'binary-claim-decisions-v4',
    supportedClaims: state.phase === 'complete' ? supportedClaims : null,
    unsupportedClaims: state.phase === 'complete' ? unsupportedClaims : null,
    // Provide auditable evidence, not simply ungrounded scalar scores.
    ...(state.phase === 'complete' ? { claims: state.verified } : {}),
  }
}
export async function GET(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('runId') ?? ''
    const { run } = await validatedRun(id)
    const state = await jsonFile<State>(fileFor(id))
    if (state && state.snapshotRevision !== run.snapshotRevision) throw new Error('Audit/run mismatch')
    return respond({ audit: state ? progress(state) : null })
  } catch (e) { return respond({ error: e instanceof Error ? e.message : String(e) }, 400) }
}
export async function POST(req: NextRequest) {
  let lock = ''
  let lockOwned = false
  try {
    const body = await req.json() as { runId?: unknown }
    const id = typeof body.runId === 'string' ? body.runId.trim() : ''
    const { run, supported, total } = await validatedRun(id)
    await mkdir(AUDITS, { recursive: true })
    lock = join(AUDITS, `${id}.lock`)
    try { await mkdir(lock); lockOwned = true }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      // Interrupted model requests may leave a lock. Never remove a live lock.
      if (Date.now() - (await stat(lock)).mtimeMs > 15 * 60_000) {
        await rm(lock, { recursive: true, force: true }); await mkdir(lock); lockOwned = true
      } else return respond({ error: 'Claim audit already processing; retry shortly' }, 409)
    }
    let state = await jsonFile<State>(fileFor(id))
    if (!state) state = { schemaVersion: 1, runId: id, snapshotRevision: run.snapshotRevision,
      model: '', phase: 'extract', chunks: chunksOf(run.summary), extractedChunks: 0,
      claims: [], verified: [], goldSupported: supported, goldTotal: total }
    if (state.runId !== id || state.snapshotRevision !== run.snapshotRevision ||
        state.goldTotal !== total || state.goldSupported !== supported || state.schemaVersion !== 1) {
      throw new Error('Saved audit no longer matches the frozen benchmark run')
    }
    if (state.phase === 'complete') return respond({ audit: progress(state), reused: true })
    const settings = await readMemexModelSettings()
    if (!state.model) state.model = settings.defaultModel
    if (state.model !== settings.defaultModel) {
      throw new Error(`Model changed since audit started (${state.model}); restore this model before resuming`)
    }
    // Write the initial checkpoint BEFORE the first model request. Even a first
    // call that times out, returns empty content, or reaches its output limit
    // can now be resumed without losing the saved Gold assessments.
    if (!(await jsonFile<State>(fileFor(id)))) await saveState(state)
    if (state.phase === 'extract') {
      const chunk = state.chunks[state.extractedChunks]
      if (!chunk) throw new Error('Claim extraction chunk is missing')
      let extracted: Claim[]
      try {
        const raw = await modelCall(settings,
          'List EVERY independently assessable factual claim asserted in this GENERATED summary excerpt. Split compound factual propositions into atomic claims. Do not invent claims or use external knowledge. Exclude non-factual headings. Return ONLY compact JSON: {"claims":[{"claim":"single factual proposition"}]}. Do not generate quotations or explanations.',
          { summaryExcerpt: chunk }, chunk.length < 350 ? 2048 : 4096)
        extracted = parseClaims(raw, chunk)
      } catch (error) {
        const halves = outputFailure(error) ? splitExtractionChunk(chunk) : null
        if (!halves) throw error
        state.chunks.splice(state.extractedChunks, 1, ...halves)
        await saveState(state)
        return respond({ audit: progress(state), adjusted: 'smaller-extraction-chunks' })
      }
      // Avoid counting repeated identical claims as extra true positives.
      const seen = new Set(state.claims.map(c => c.claim.toLowerCase().replace(/\s+/g, ' ')))
      for (const item of extracted) {
        const key = item.claim.toLowerCase().replace(/\s+/g, ' ')
        if (!seen.has(key)) { state.claims.push(item); seen.add(key) }
      }
      if (state.claims.length > 500) throw new Error('Over 500 extracted claims; stop without persisting incomplete audit')
      state.extractedChunks++
      if (state.extractedChunks === state.chunks.length) {
        if (!state.claims.length) throw new Error('No assessable summary claims were extracted')
        state.phase = 'verify'
      }
    } else {
      const original = await originalSource(run)
      const batchSize = state.verifyBatchSize ?? 4
      const batch = state.claims.slice(state.verified.length, state.verified.length + batchSize)
      if (!batch.length) throw new Error('Claim verification has no remaining claims')
      let verdicts: Verdict[]
      try {
        const raw = await modelCall(settings,
          'Act as an independent binary fact-checking judge, using ONLY the frozen ORIGINAL. Do not use Gold facts. Return one verdict per numbered claim, IN ORDER. supported=true ONLY if the original fully entails the claim, including qualifications and scope. Partial, invented, uncertain or contradicted => supported=false. Provide 0-100 confidence, a reason of at most 20 words, and OPTIONAL sourceEvidence (exact quote when available, otherwise empty). Do NOT spend tokens reproducing the source. Return ONLY JSON: {"verdicts":[{"id":1,"supported":true,"confidence":85,"reason":"short decision rationale","sourceEvidence":""}]}.',
          { original, claims: batch.map((c, i) => ({ id: i + 1, claim: c.claim })) }, batch.length === 1 ? 8192 : 4096)
        verdicts = parseVerdicts(raw, batch, original)
      } catch (error) {
        if (!outputFailure(error) || batch.length < 2) throw error
        state.verifyBatchSize = Math.max(1, Math.floor(batch.length / 2))
        await saveState(state)
        return respond({ audit: progress(state), adjusted: 'smaller-verification-batches' })
      }
      state.verified.push(...verdicts)
      if (state.verified.length === state.claims.length) {
        state.phase = 'complete'; state.evaluatedAt = new Date().toISOString()
      }
    }
    await saveState(state)
    return respond({ audit: progress(state) })
  } catch (e) { return respond({ error: e instanceof Error ? e.message : String(e) }, 400) }
  finally { if (lockOwned) await rm(lock, { recursive: true, force: true }).catch(() => undefined) }
}
