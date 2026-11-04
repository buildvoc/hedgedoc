import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { NextRequest, NextResponse } from 'next/server'

import { readMemexModelSettings } from '../../memex-model-settings/_settings'
import { readMemexApiToken } from '../../memex-revisions/_proxy'
import { authorizedOkfOperator, okfRelationsWriteEnabled } from '../_auth'
import {
  aggregate, readSourceIndex, writeSourceIndex,
  type ClassifiedSummary, type ConceptEvidence, type SourceIndex,
} from '../_source_index'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAINTAIN = (process.env.MEMEX_WIKI_MAINTAIN_URL ??
  'http://127.0.0.1:3101/memex-wiki-maintain').replace(/\/+$/, '')
// New path: does not delete or mistake the old 8 x 1 preview for source coverage.
const PREVIEW_PATH = process.env.MEMEX_OKF_SOURCE_PREVIEW_PATH ??
  '/data/projects/hedgedoc/memex/okf-source-refresh-preview.json'
const CHUNK = 4
const VERIFY_WORKERS = Math.max(
  1,
  Math.min(8, Number.parseInt(process.env.MEMEX_OKF_VERIFY_WORKERS ?? '4', 10) || 4),
)
// Trail refresh reads one source then calls the LLM. Never fan out hundreds
// of HedgeDoc API calls during OKF startup or approval.
const NOTE_API = (process.env.MEMEX_HEDGEDOC_API_BASE ??
  'http://127.0.0.1:3100/api/v2/notes').replace(/\/+$/, '')
const SOURCE_READ_GAP_MS = 3100
let nextReadAt = 0
async function pacedRead(): Promise<void> {
  const now = Date.now()
  const wait = Math.max(0, nextReadAt - now)
  nextReadAt = now + wait + SOURCE_READ_GAP_MS
  if (wait) await new Promise<void>((resolve) => setTimeout(resolve, wait))
}
class RateLimited extends Error {
  constructor(readonly retrySeconds: number) {
    super(`HedgeDoc source API rate limit (429); retry after ${retrySeconds}s; completed work saved`)
  }
}

const MAX_READY_AGE_MS = 24 * 60 * 60 * 1000
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

type Page = {
  alias: string
  title: string
  description: string
  type: 'source-summary' | 'topic' | 'entity'
  hash: string
  rawAliases: string[]
  excerpt: string
}
type Job = {
  version: 3
  id: string
  createdAt: string
  updatedAt: string
  state: 'running' | 'paused' | 'verifying' | 'ready' | 'applied'
  model: string
  provider: string
  snapshotHash: string
  registryHash: string
  verified: number
  expectedIndexRevision: string
  summaries: Page[]
  topics: Page[]
  entities: Page[]
  step: number
  totalSteps: number
  decisions: ClassifiedSummary[]
  rejectedCandidates?: number
  flaggedSummaries?: string[]
}

// Only serializes this process's refresh requests. Disk snapshots still prevent
// stale Apply; do not run multiple independent frontend replicas without a lock.
let busy = false
async function exclusive<T>(action: () => Promise<T>): Promise<T> {
  if (busy) throw new Error('OKF_REFRESH_BUSY')
  busy = true
  try { return await action() } finally { busy = false }
}

function sameOrigin(request: NextRequest): boolean {
  try {
    const origin = request.headers.get('origin')
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
    return !!origin && !!host && new URL(origin).host === host
  } catch { return false }
}

async function readJob(): Promise<Job | null> {
  let raw = ''
  try { raw = await readFile(PREVIEW_PATH, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const value: unknown = JSON.parse(raw)
  // Preserve v2 LLM checkpoints; migrate the old eager-snapshot job without
  // discarding completed model decisions or re-requesting them.
  if (isObj(value) && value.version === 2 &&
      Array.isArray(value.summaries) && Array.isArray(value.topics) &&
      Array.isArray(value.entities) && Array.isArray(value.decisions) &&
      typeof value.id === 'string' && typeof value.step === 'number') {
    const old = value as unknown as Job
    const migrated: Job = {
      ...old, version: 3, verified: 0,
      registryHash: registryHash(old),
      snapshotHash: sourceHash(old.summaries),
      state: old.state === 'ready' ? 'verifying' : old.state,
    }
    await writeJob(migrated)
    return migrated
  }
  if (!isObj(value) || value.version !== 3 || !Array.isArray(value.summaries) ||
      !Array.isArray(value.decisions) || !Array.isArray(value.topics) ||
      !Array.isArray(value.entities) || typeof value.id !== 'string' ||
      typeof value.step !== 'number' || typeof value.verified !== 'number' ||
      typeof value.registryHash !== 'string') {
    throw new Error('Invalid source-summary OKF preview schema')
  }
  return value as unknown as Job
}

async function writeJob(job: Job): Promise<void> {
  await mkdir(dirname(PREVIEW_PATH), { recursive: true })
  const tmp = `${PREVIEW_PATH}.tmp-${randomBytes(8).toString('hex')}`
  await writeFile(tmp, JSON.stringify(job, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  await rename(tmp, PREVIEW_PATH)
}

function parseSources(markdown: string): string[] {
  const yaml = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
  const block = yaml.match(/^sources:\s*\r?\n((?:[ \t]+[^\r\n]*\r?\n?)*)/m)?.[1] ?? ''
  return [...new Set([...block.matchAll(/\/(?:n|s)\/([A-Za-z0-9_-]+)/g)]
    .map((m) => m[1]).filter((a) => !a.startsWith('memex-wiki-')))]
}

// Catalogue lookup reads ONLY the Wiki index: one HedgeDoc API request.
// Source content is fetched in small, checkpointed, trail-style steps.
async function catalogue(): Promise<{ summaries: Page[]; topics: Page[]; entities: Page[] }> {
  const response = await fetch(MAINTAIN, { cache: 'no-store' })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500)
    // The maintain proxy currently wraps HedgeDoc 429 as HTTP 500.
    // Preserve 429 semantics for resumable, trail-style backoff.
    if (response.status === 429 || /failed \(429\)/i.test(detail)) {
      throw new RateLimited(300)
    }
    throw new Error(`Wiki catalogue HTTP ${response.status}: ${detail}`)
  }
  const parsed: unknown = await response.json()
  if (!isObj(parsed) || !Array.isArray(parsed.pages)) throw new Error('Invalid Wiki catalogue')
  const entries = parsed.pages.flatMap((v: unknown): Page[] => {
    if (!isObj(v) || (v.pageType !== 'source-summary' && v.pageType !== 'topic' && v.pageType !== 'entity') ||
        typeof v.alias !== 'string' || typeof v.title !== 'string') return []
    return [{ alias: v.alias, title: v.title, type: v.pageType,
      description: typeof v.description === 'string' ? v.description : '',
      hash: '', rawAliases: [], excerpt: '' }]
  }).sort((a, b) => a.alias.localeCompare(b.alias))
  if (entries.length > 2500) throw new Error('OKF catalogue exceeds 2500 pages')
  if (new Set(entries.map((e) => e.alias)).size !== entries.length) throw new Error('Duplicate Wiki alias')
  return {
    summaries: entries.filter((p) => p.type === 'source-summary'),
    topics: entries.filter((p) => p.type === 'topic'),
    entities: entries.filter((p) => p.type === 'entity'),
  }
}

// Note identity is guarded by the registered index, a derived-page marker,
// and the content hash. Direct backend reads avoid refetching the Wiki index
// for each source-summary request (the previous code did that 342 times).
async function noteMarkdown(alias: string, paced = true): Promise<string> {
  if (paced) await pacedRead()
  const token = await readMemexApiToken()
  const response = await fetch(`${NOTE_API}/${encodeURIComponent(alias)}/content`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
    signal: AbortSignal.timeout(25000),
  })
  if (response.status === 429) {
    const raw = response.headers.get('retry-after')
    let seconds = Number(raw)
    if ((!Number.isFinite(seconds) || seconds < 1) && raw) {
      const date = Date.parse(raw)
      if (Number.isFinite(date)) seconds = Math.ceil((date - Date.now()) / 1000)
    }
    throw new RateLimited(Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 300)
  }
  if (!response.ok) throw new Error(`HedgeDoc GET ${alias} HTTP ${response.status}`)
  const markdown = await response.text()
  const yaml = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
  if (!/^\s*-\s+memex-wiki\s*$/m.test(yaml)) {
    throw new Error(`Source ${alias} is not a derived Memex Wiki page`)
  }
  return markdown
}

async function completePage(entry: Page): Promise<Page> {
  const markdown = await noteMarkdown(entry.alias)
  const end = markdown.match(/^---\r?\n[\s\S]*?\r?\n---/)?.[0].length ?? 0
  return {
    ...entry, hash: sha(markdown), rawAliases: parseSources(markdown),
    excerpt: markdown.slice(end).replace(/\s+/g, ' ').trim().slice(0, 8000),
  }
}

function registryHash(snapshot: { summaries: Page[]; topics: Page[]; entities: Page[] }): string {
  const pages = [...snapshot.summaries, ...snapshot.topics, ...snapshot.entities]
  return sha(JSON.stringify(pages.map((p) => [p.alias, p.type, p.title, p.description])
    .sort((a, b) => a[0].localeCompare(b[0]))))
}

function sourceHash(pages: Page[]): string {
  return sha(JSON.stringify(pages.map((p) => [p.alias, p.hash])))
}

// Invalid model output is retryable; it is NEVER converted into empty reviews.
class ModelOutputError extends Error {}

function modelJson(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  // Remove explanatory prefix/suffix only when there is a complete JSON object.
  const start = trimmed.indexOf('{')
  if (start < 0) throw new ModelOutputError('LLM returned invalid JSON (no object)')
  let inside = false
  let escaped = false
  let depth = 0
  let end = -1
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i]
    if (inside) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inside = false
    } else if (c === '"') inside = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) { end = i + 1; break }
  }
  if (end < 0) throw new ModelOutputError('LLM returned truncated JSON')
  const objectText = trimmed.slice(start, end)
  // Repairs only JSON syntax, never invents missing classification evidence.
  function repairSyntax(input: string): string {
    let output = ''
    let quoted = false
    let escape = false
    for (let i = 0; i < input.length; i++) {
      const ch = input[i]
      if (quoted) {
        if (escape) { output += ch; escape = false; continue }
        if (ch === '\\') { output += ch; escape = true; continue }
        if (ch === '"') { quoted = false; output += ch; continue }
        const code = ch.charCodeAt(0)
        if (code < 32) { output += `\\u${code.toString(16).padStart(4, '0')}`; continue }
        output += ch
      } else {
        if (ch === '"') quoted = true
        if (ch === ',') {
          let j = i + 1
          while (j < input.length && /\s/.test(input[j])) j++
          if (input[j] === '}' || input[j] === ']') continue
        }
        output += ch
      }
    }
    return output
  }
  let decoded: unknown
  try { decoded = JSON.parse(objectText) }
  catch {
    try { decoded = JSON.parse(repairSyntax(objectText)) }
    catch { throw new ModelOutputError('LLM returned invalid JSON; batch not checkpointed') }
  }
  if (!isObj(decoded)) throw new ModelOutputError('LLM JSON must be an object')
  return decoded
}

// A single malformed LLM candidate must never abort the 4-source checkpoint.
// We only accept strictly source-supported quotes; invalid items are excluded
// and counted so operators can evaluate partial classification quality.
function cleanEvidence(raw: unknown, excerpt: string): {
  evidence: ConceptEvidence[]
  rejected: number
} {
  // Some JSON-mode responses serialize a single concept as an object.
  // Its evidence is still validated below; missing or null arrays are retryable.
  if (isObj(raw) && typeof raw.name === 'string' && typeof raw.quote === 'string') {
    raw = [raw]
  }
  if (!Array.isArray(raw)) throw new ModelOutputError('LLM reviews must contain topics/entities arrays')
  let rejected = 0
  const names = new Set<string>()
  const evidence: ConceptEvidence[] = []
  const canonical = (text: string) => text.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
  const source = canonical(excerpt)
  for (const candidate of raw) {
    if (!isObj(candidate) || typeof candidate.name !== 'string' ||
      typeof candidate.quote !== 'string') {
      rejected++
      continue
    }
    const name = candidate.name.trim().replace(/\s+/g, ' ')
    const quote = candidate.quote.trim().replace(/\s+/g, ' ')
    const rawConfidence = candidate.confidence
    // JSON models sometimes serialize confidence as "0.86" or "86%".
    // Only numeric values are accepted; no guessed/default confidence.
    let confidence: number
    if (typeof rawConfidence === 'number') confidence = rawConfidence
    else if (typeof rawConfidence === 'string' &&
      /^(?:0(?:\.\d+)?|1(?:\.0+)?|\d{1,3}%)$/.test(rawConfidence.trim())) {
      const v = rawConfidence.trim()
      confidence = v.endsWith('%') ? Number(v.slice(0, -1)) / 100 : Number(v)
    } else {
      rejected++
      continue
    }
    // Short exact quotations such as "Lutyens" or "Bath" are valid evidence.
    if (name.length < 3 || name.length > 120 || /[\r\n<>]/.test(name) ||
        quote.length < 3 || quote.length > 1000 ||
        !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      rejected++
      continue
    }
    if (names.has(canonical(name))) continue
    // A model assertion is NEVER accepted unless the quote is actually in
    // this source summary, independent of confidence.
    if (!source.includes(canonical(quote)) || confidence < 0.70) {
      rejected++
      continue
    }
    if (evidence.length >= 4) {
      rejected++
      continue
    }
    names.add(canonical(name))
    evidence.push({ name, quote, confidence })
  }
  return { evidence, rejected }
}

const OKF_EXISTING_CATALOGUE_PROMPT_CHARS = 12000

function catalogueTerms(text: string): string[] {
  return text.toLocaleLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []
}

function rankExistingPages(summaries: Page[], pages: Page[]): Page[] {
  const sourceText = summaries
    .map((p) => `${p.title} ${p.description} ${p.excerpt}`)
    .join(' ')
    .toLocaleLowerCase()
  const sourceTerms = new Set(catalogueTerms(sourceText).filter((term) => term.length >= 4))
  return pages.map((page) => {
    const title = page.title.toLocaleLowerCase()
    let score = title.length >= 3 && sourceText.includes(title) ? 10000 : 0
    for (const term of catalogueTerms(page.title)) {
      if (term.length >= 4 && sourceTerms.has(term)) score += 8
    }
    for (const term of catalogueTerms(page.description)) {
      if (term.length >= 5 && sourceTerms.has(term)) score += 1
    }
    return { page, score }
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.page.alias.localeCompare(b.page.alias))
    .map(({ page }) => page)
}

function boundedExistingCatalogue(summaries: Page[], topics: Page[], entities: Page[]): {
  topics: { title: string; alias: string }[]
  entities: { title: string; alias: string }[]
} {
  const rankedTopics = rankExistingPages(summaries, topics)
  const rankedEntities = rankExistingPages(summaries, entities)
  const existing: {
    topics: { title: string; alias: string }[]
    entities: { title: string; alias: string }[]
  } = { topics: [], entities: [] }
  const total = Math.max(rankedTopics.length, rankedEntities.length)
  for (let i = 0; i < total; i++) {
    for (const [key, ranked] of [
      ['topics', rankedTopics], ['entities', rankedEntities],
    ] as const) {
      const page = ranked[i]
      if (!page) continue
      const entry = { title: page.title, alias: page.alias }
      const candidate = { ...existing, [key]: [...existing[key], entry] }
      if (JSON.stringify(candidate).length <= OKF_EXISTING_CATALOGUE_PROMPT_CHARS) {
        existing[key].push(entry)
      }
    }
  }
  return existing
}

async function evaluateBatch(summaries: Page[], topics: Page[], entities: Page[]): Promise<{
  decisions: ClassifiedSummary[]
  rejectedCandidates: number
  flaggedSummaries: string[]
}> {
  const settings = await readMemexModelSettings()
  const payloadSummaries = summaries.map((p) => ({
    alias: p.alias, title: p.title, description: p.description,
    rawAliases: p.rawAliases, excerpt: p.excerpt,
  }))
  const existing = boundedExistingCatalogue(summaries, topics, entities)
  const retryMode = summaries.length === 1
  const strictHint = retryMode ? `SINGLE SOURCE FALLBACK. The output must be a JSON object with one field named reviews.
The reviews field MUST be an ARRAY containing EXACTLY ONE object, with keys alias, topics, entities.
The topics and entities fields MUST EACH be ARRAYS. Use [] when genuinely no grounded evidence is found.
NEVER use null, strings, objects, comments, or omitted fields for topics/entities.
Example of correct empty classification: {"reviews":[{"alias":${JSON.stringify(summaries[0].alias)},"topics":[],"entities":[]}]}.
Do not default to empty arrays when source-backed evidence exists.
` : ''
  const prompt = `${strictHint}Memex OKF REFRESH: review EACH source-summary below independently.
The catalogue is 342 source summaries (or a different actual current count), NOT just existing Topic x Entity pairs.
Identify grounded Topic subjects and named Entities (people, places, organizations, works) in the summary.
Prefer established catalogue titles when truly applicable, but DISCOVER NEW Topic/Entity names too.
Do not force links to Inigo Triggs or any other existing Entity. A source can have zero topics/entities.
Quote an EXACT contiguous substring of the supplied excerpt for EVERY positive; no invented facts.
Keep every quote SHORT (3-120 characters). Keep names brief. Output compact JSON only;
never add markdown or commentary. Ensure the closing ]} is present.
Return only valid JSON: {"reviews":[{"alias":"exact source-summary alias",
"topics":[{"name":"specific subject","quote":"exact excerpt substring","confidence":0.0}],
"entities":[{"name":"named entity","quote":"exact excerpt substring","confidence":0.0}]}]}.
One review for EVERY supplied alias, even with empty arrays. At most 4 topics and 4 entities per source.
Confidence in [0,1]. Use high precision, no broad generic grouping, no canonical associated_with changes.
Existing catalogue: ${JSON.stringify(existing)}
Source summaries: ${JSON.stringify(payloadSummaries)}`
  const promptBudget = Math.min(settings.maxPromptChars, 65000)
  console.info('MEMEX OKF source-summary prompt',
    `chars=${prompt.length}`, `budget=${promptBudget}`,
    `topics=${existing.topics.length}/${topics.length}`,
    `entities=${existing.entities.length}/${entities.length}`)
  if (prompt.length > promptBudget) {
    throw new Error('Source-summary prompt exceeds configured Memex model budget')
  }
  const base = settings.baseUrl.replace(/\/+$/, '')
  const endpoint = settings.provider === 'ollama' ? `${base}/api/chat` : `${base}/chat/completions`
  const requestBody = settings.provider === 'ollama' ? {
    model: settings.defaultModel, stream: false, format: 'json',
    messages: [{ role: 'user', content: prompt }],
    options: { temperature: 0.1, num_ctx: settings.numCtx },
  } : {
    model: settings.defaultModel, stream: false, temperature: 0.1,
    response_format: { type: 'json_object' },
    max_tokens: 6144, reasoning_effort: 'none', id_slot: 0,
    cache_prompt: settings.llamacppCachePrompt,
    messages: [{ role: 'user', content: prompt }],
  }
  const response = await fetch(endpoint, {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody), signal: AbortSignal.timeout(settings.timeoutSeconds * 1000),
  })
  if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${(await response.text()).slice(0, 250)}`)
  const outer: unknown = await response.json()
  if (!isObj(outer)) throw new Error('Invalid LLM response envelope')
  const content = settings.provider === 'ollama'
    ? (isObj(outer.message) ? outer.message.content : undefined)
    : (Array.isArray(outer.choices) && isObj(outer.choices[0]) &&
        isObj(outer.choices[0].message) ? outer.choices[0].message.content : undefined)
  if (typeof content !== 'string') throw new ModelOutputError('LLM returned no classification content')
  const json = modelJson(content)
  // Single-source output can be safely associated with the only source, even
  // when the model omits the outer reviews wrapper or repeats a review object.
  // This is never allowed for four-source batches, where aliases are mandatory.
  let rawReviews: unknown = json.reviews
  if (summaries.length === 1 && !Array.isArray(rawReviews)) {
    if (isObj(json.review)) rawReviews = [json.review]
    else if ('topics' in json && 'entities' in json) {
      rawReviews = [json]
    }
  }
  if (!Array.isArray(rawReviews) || rawReviews.length !== summaries.length) {
    throw new ModelOutputError('Incomplete LLM review batch: all source summaries must receive a verdict')
  }
  const remaining = new Map(summaries.map((p) => [p.alias, p]))
  const decisions: ClassifiedSummary[] = []
  let rejectedCandidates = 0
  const flaggedSummaries: string[] = []
  for (const raw of rawReviews) {
    if (!isObj(raw)) throw new ModelOutputError('Malformed source-summary LLM review')
    const alias = (summaries.length === 1 && (raw.alias === undefined || raw.alias === ''))
      ? summaries[0].alias : raw.alias
    if (typeof alias !== 'string' || !remaining.has(alias)) {
      throw new ModelOutputError('Unknown or repeated source-summary alias in LLM review')
    }
    const summary = remaining.get(alias)!
    remaining.delete(alias)
    const topics = cleanEvidence(raw.topics, summary.excerpt)
    const entities = cleanEvidence(raw.entities, summary.excerpt)
    const invalid = topics.rejected + entities.rejected
    rejectedCandidates += invalid
    if (invalid) flaggedSummaries.push(summary.alias)
    decisions.push({ alias: summary.alias, rawAliases: summary.rawAliases,
      topics: topics.evidence, entities: entities.evidence })
  }
  if (remaining.size) throw new ModelOutputError('Missing source-summary reviews')
  return { decisions, rejectedCandidates, flaggedSummaries }
}


// Retry only malformed output (not HTTP/API failures), one source at a time.
// The batch commits only when every source returns an explicit, valid verdict.
async function evaluateSingle(summary: Page[], topics: Page[], entities: Page[]): Promise<{
  decisions: ClassifiedSummary[]
  rejectedCandidates: number
  flaggedSummaries: string[]
}> {
  let last = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await evaluateBatch(summary, topics, entities) }
    catch (error) {
      if (!(error instanceof ModelOutputError)) throw error
      last = error.message
    }
  }
  throw new ModelOutputError(
    `Source ${summary[0].alias} had malformed output on 3 attempts (${last}); preview checkpoint unchanged`
  )
}

async function evaluate(summaries: Page[], topics: Page[], entities: Page[]): Promise<{
  decisions: ClassifiedSummary[]
  rejectedCandidates: number
  flaggedSummaries: string[]
}> {
  if (summaries.length === 1) return evaluateSingle(summaries, topics, entities)
  try { return await evaluateBatch(summaries, topics, entities) }
  catch (error) {
    if (!(error instanceof ModelOutputError)) throw error
    const decisions: ClassifiedSummary[] = []
    const flaggedSummaries: string[] = []
    let rejectedCandidates = 0
    for (const summary of summaries) {
      const result = await evaluateSingle([summary], topics, entities)
      decisions.push(...result.decisions)
      rejectedCandidates += result.rejectedCandidates
      flaggedSummaries.push(...result.flaggedSummaries)
    }
    return { decisions, rejectedCandidates, flaggedSummaries }
  }
}

function publicJob(job: Job | null) {
  if (!job) return { available: false }
  const groups = aggregate(job.decisions)
  return {
    available: true, id: job.id, state: job.state,
    step: job.step, totalSteps: job.totalSteps, verified: job.verified,
    reviews: job.decisions.length, sourceSummaries: job.summaries.length,
    wikiTopics: job.topics.length, wikiEntities: job.entities.length,
    model: job.model, provider: job.provider,
    rejectedCandidates: job.rejectedCandidates ?? 0,
    flaggedSummaries: job.flaggedSummaries ?? [],
    generatedTopics: groups.topics, generatedEntities: groups.entities,
    navigationCandidates: groups.cooccurrences,
    ready: job.state === 'ready' && Date.now() - Date.parse(job.updatedAt) < MAX_READY_AGE_MS,
  }
}

function problem(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof RateLimited) {
    return NextResponse.json({ error: message, retrySeconds: error.retrySeconds },
      { status: 429, headers: { 'Retry-After': String(error.retrySeconds) } })
  }
  const status = /STALE|BUSY|expired|changed/i.test(message) ? 409 :
    /LLM|model/i.test(message) ? 502 : 500
  return NextResponse.json({ error: message }, { status })
}

export async function GET(request: NextRequest) {
  if (!(await authorizedOkfOperator(request))) {
    return NextResponse.json({ error: 'Signed-in OKF operator required' }, { status: 403 })
  }
  try {
    const job = await readJob()
    const approved = await readSourceIndex()
    const storedGroups = approved.index ? aggregate(approved.index.summaries) : null
    return NextResponse.json({ ...publicJob(job), approved: {
      summaries: approved.index?.summaries.length ?? 0,
      topics: storedGroups?.topics.length ?? 0,
      entities: storedGroups?.entities.length ?? 0,
      cooccurrences: storedGroups?.cooccurrences.length ?? 0,
      updatedAt: approved.index?.updatedAt ?? null,
    } }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return problem(error) }
}

export async function POST(request: NextRequest) {
  if (!(await authorizedOkfOperator(request)) || !sameOrigin(request)) {
    return NextResponse.json({ error: 'Operator session or Origin rejected' }, { status: 403 })
  }
  let input: Record<string, unknown>
  try {
    const value: unknown = await request.json()
    if (!isObj(value)) throw new Error('JSON object required')
    input = value
  } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  try {
    const result = await exclusive(async () => {
      if (input.action === 'start') {
        const [pages, saved, settings] = await Promise.all([
          catalogue(), readSourceIndex(), readMemexModelSettings(),
        ])
        if (!pages.summaries.length) throw new Error('No source-summary wiki pages found')
        const now = new Date().toISOString()
        const job: Job = { version: 3, id: randomBytes(16).toString('hex'),
          createdAt: now, updatedAt: now, state: 'running',
          model: settings.defaultModel, provider: settings.provider,
          snapshotHash: '', registryHash: registryHash(pages), verified: 0,
          expectedIndexRevision: saved.revision,
          summaries: pages.summaries, topics: pages.topics, entities: pages.entities,
          step: 0, totalSteps: Math.ceil(pages.summaries.length / CHUNK), decisions: [],
          rejectedCandidates: 0, flaggedSummaries: [],
        }
        await writeJob(job)
        return publicJob(job)
      }
      const job = await readJob()
      if (!job) throw new Error('Start a source-summary OKF refresh first')
      if (typeof input.id !== 'string' || input.id !== job.id) throw new Error('STALE_PREVIEW_ID')
      if (input.action === 'step') {
        if (job.state === 'running' || job.state === 'paused') {
          if (job.step >= job.totalSteps) throw new Error('No remaining source summaries')
          // Just four reads per LLM batch, like the existing Trail workflow.
          // A 429 keeps the last successfully saved batch intact.
          const offset = job.step * CHUNK
          const entries = job.summaries.slice(offset, offset + CHUNK)
          const pages: Page[] = []
          for (const entry of entries) pages.push(await completePage(entry))
          const batch = await evaluate(pages, job.topics, job.entities)
          job.summaries.splice(offset, pages.length, ...pages)
          job.decisions.push(...batch.decisions)
          job.rejectedCandidates = (job.rejectedCandidates ?? 0) + batch.rejectedCandidates
          job.flaggedSummaries = [...new Set([
            ...(job.flaggedSummaries ?? []), ...batch.flaggedSummaries,
          ])]
          job.step++
          job.updatedAt = new Date().toISOString()
          if (job.step === job.totalSteps) {
            job.snapshotHash = sourceHash(job.summaries)
            job.state = 'verifying'
          } else { job.state = 'running' }
          await writeJob(job)
          return publicJob(job)
        }
        if (job.state === 'verifying') {
          // Verification is read-only: use a bounded local worker batch.
          // Normal LLM-review source reads remain globally paced.
          const offset = job.verified
          const batch = job.summaries.slice(offset, offset + VERIFY_WORKERS)
          const verified = await Promise.all(batch.map(async (entry) => ({
            entry,
            markdown: await noteMarkdown(entry.alias, false),
          })))
          for (const { entry, markdown } of verified) {
            if (sha(markdown) !== entry.hash) {
              throw new Error(`STALE_PREVIEW: source summary changed: ${entry.alias}`)
            }
          }
          job.verified += batch.length
          job.updatedAt = new Date().toISOString()
          if (job.verified === job.summaries.length) {
            const live = await catalogue()
            if (registryHash(live) !== job.registryHash) {
              throw new Error('STALE_PREVIEW: Wiki catalogue changed')
            }
            job.state = 'ready'
          }
          await writeJob(job)
          return publicJob(job)
        }
        throw new Error('Refresh is not running or verifying')
      }
      if (input.action === 'pause') {
        if (job.state === 'running') job.state = 'paused'
        // Verification is read-only and already checkpointed; browser Stop
        // can simply interrupt the iteration and Resume later.
        job.updatedAt = new Date().toISOString()
        await writeJob(job)
        return publicJob(job)
      }
      if (input.action === 'apply') {
        if (!(await okfRelationsWriteEnabled())) throw new Error('OKF navigation writes disabled')
        if (input.confirmation !== 'APPLY' || job.state !== 'ready' ||
            job.decisions.length !== job.summaries.length ||
            job.verified !== job.summaries.length) {
          throw new Error('Complete full source review and verification; confirm APPLY')
        }
        if (Date.now() - Date.parse(job.updatedAt) > MAX_READY_AGE_MS) {
          throw new Error('Preview expired: review again')
        }
        // One Wiki catalogue lookup, not 342 separate page fetches.
        const [live, stored] = await Promise.all([catalogue(), readSourceIndex()])
        if (registryHash(live) !== job.registryHash ||
            sourceHash(job.summaries) !== job.snapshotHash ||
            stored.revision !== job.expectedIndexRevision) {
          throw new Error('STALE_PREVIEW: Wiki catalogue or OKF index changed')
        }
        const next: SourceIndex = {
          version: 1, updatedAt: new Date().toISOString(),
          sourceSnapshotHash: job.snapshotHash,
          model: job.model, provider: job.provider, summaries: job.decisions,
        }
        await writeSourceIndex(next, job.expectedIndexRevision)
        job.state = 'applied'
        job.updatedAt = new Date().toISOString()
        await writeJob(job)
        return { ...publicJob(job), committed: true, sourceSummariesApplied: next.summaries.length }
      }
      throw new Error('Unsupported OKF refresh action')
    })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return problem(error) }
}
