import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { readMemexModelSettings } from '../../memex-model-settings/_settings'
import { readMemexApiToken } from '../../memex-revisions/_proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const REV = /^[0-9a-f-]{16,64}$/i
const ALIAS = /^[a-z0-9][a-z0-9_-]{0,127}$/i
const PROJECT = process.env.MEMEX_PROJECT_ROOT ?? '/data/projects/hedgedoc'
const GOLD_DIR = process.env.MEMEX_WIKI_BENCHMARK_GOLD_DIR ?? join(PROJECT, 'memex/benchmarks/summary/gold')
const RUN_DIR = process.env.MEMEX_WIKI_BENCHMARK_RUN_DIR ?? join(PROJECT, 'memex/benchmarks/summary/runs')
const NOTES = process.env.HEDGEDOC_NOTES_API ?? 'http://127.0.0.1:3100/api/v2/notes'
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

type Frozen = { snapshotRevision: string; source: { alias: string; revisionId: string }; reference: { alias: string; revisionId: string; sourceAlias: string }; facts: Array<{ id: string; expectation: string }>; reviewer: string }

async function getOriginal(alias: string, revisionId: string): Promise<string> {
  const token = await readMemexApiToken()
  const r = await fetch(`${NOTES}/${encodeURIComponent(alias)}/revisions/${encodeURIComponent(revisionId)}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
  if (!r.ok) throw new Error(`Frozen source revision unavailable (HTTP ${r.status})`)
  const d = await r.json() as { content?: unknown }
  if (typeof d.content !== 'string') throw new Error('Frozen source content missing')
  return d.content
}


// Resolve a user-selected HedgeDoc source-summary at the time Run is clicked.
// Only the local authenticated HedgeDoc API is fetched; a pasted URL supplies
// the alias, never an arbitrary remote fetch destination.
function selectedAlias(input: string): string {
  let value = input.trim()
  if (/^https?:\/\//i.test(value)) {
    const path = new URL(value).pathname
    const match = path.match(/^\/n\/([^/]+)\/?$/)
    if (!match) throw new Error('Expected a HedgeDoc /n/alias URL')
    value = decodeURIComponent(match[1])
  }
  if (!ALIAS.test(value)) throw new Error('Invalid HedgeDoc source-summary alias')
  return value
}
function scalar(frontmatter: string, key: string): string {
  const line = frontmatter.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'm'))?.[1]?.trim() ?? ''
  if (line.startsWith('"')) {
    try { return JSON.parse(line) as string } catch { throw new Error(`Invalid ${key} YAML string`) }
  }
  if (line.startsWith("'") && line.endsWith("'")) return line.slice(1, -1).replace(/''/g, "'")
  return line
}
type SummaryNote = { alias: string; revisionId: string; title: string; generatorModel: string; originalRevision?: string }
async function loadSelectedSummary(input: string, source: Frozen['source']): Promise<{ summary: string; document: string; note: SummaryNote }> {
  const alias = selectedAlias(input)
  if (alias === source.alias || alias.toLowerCase().startsWith('memex-gold-summary-')) {
    throw new Error('Select a generated source-summary, not the original or a Gold Reference')
  }
  const token = await readMemexApiToken()
  const revisionsResponse = await fetch(`${NOTES}/${encodeURIComponent(alias)}/revisions`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
  })
  if (!revisionsResponse.ok) throw new Error(`Source-summary revisions unavailable (HTTP ${revisionsResponse.status})`)
  const revisions = await revisionsResponse.json() as Array<{ uuid?: string; createdAt?: string }>
  if (!Array.isArray(revisions) || !revisions.length) throw new Error('Source-summary has no revisions')
  const latest = [...revisions].sort((a,b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0))[0]
  const revisionId = latest?.uuid || ''
  if (!REV.test(revisionId)) throw new Error('Source-summary latest revision invalid')
  const document = await getOriginal(alias, revisionId)
  const match = document.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) throw new Error('Source-summary lacks valid YAML frontmatter')
  const yaml = match[1]
  if (scalar(yaml, 'memex_page_type') !== 'source-summary' ||
      scalar(yaml, 'memex_benchmark_role') !== 'none') {
    throw new Error('Selected HedgeDoc is not a source-summary with benchmark role none')
  }
  const model = scalar(yaml, 'memex_benchmark_gold_generator_model')
  if (!model) throw new Error('Source-summary is missing its generating model metadata')
  // Restrict association checking to the YAML sources list, never prose matches.
  const sourcesBlock = yaml.match(/^sources:\s*\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))*)/m)?.[1] ?? ''
  const aliases = [...sourcesBlock.matchAll(/\/n\/([a-z0-9_-]+)/gi)].map(m => m[1])
  if (!aliases.includes(source.alias)) throw new Error(`Source-summary YAML does not reference frozen original ${source.alias}`)
  const provenance = scalar(yaml, 'memex_change_provenance')
  const originalRevision = provenance.match(/\brevision\s+([0-9a-f-]{16,64})\b/i)?.[1]
  if (originalRevision && originalRevision !== source.revisionId) {
    throw new Error(`Source-summary was generated from source revision ${originalRevision}, not frozen revision ${source.revisionId}; create a matching snapshot`)
  }
  const summary = document.slice(match[0].length).trim()
  if (!summary) throw new Error('Selected source-summary has no Markdown body')
  return { summary, document, note: { alias, revisionId,
    title: scalar(yaml, 'title') || alias, generatorModel: model,
    ...(originalRevision ? { originalRevision } : {}) } }
}

export async function GET(request: NextRequest) {
  try {
    const rev = request.nextUrl.searchParams.get('snapshotRevision')?.trim() || ''
    const alias = request.nextUrl.searchParams.get('summaryAlias')?.trim() || ''
    if (!REV.test(rev)) return reply({ error: 'Valid snapshotRevision required' }, 400)
    const gold = JSON.parse(await readFile(join(GOLD_DIR, `${rev}.json`), 'utf8')) as Frozen
    if (gold.snapshotRevision !== rev || !gold.reviewer || !gold.facts?.length ||
        gold.reference?.sourceAlias !== gold.source?.alias || !REV.test(gold.source.revisionId)) {
      throw new Error('Saved Gold Set invalid')
    }
    const selected = await loadSelectedSummary(alias, gold.source)
    return reply({ sourceSummary: selected.note, model: selected.note.generatorModel })
  } catch (e) { return reply({ error: e instanceof Error ? e.message : String(e) }, 400) }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { snapshotRevision?: unknown; summaryAlias?: unknown }
    const rev = typeof body.snapshotRevision === 'string' ? body.snapshotRevision.trim() : ''
    if (!REV.test(rev)) return reply({ error: 'Valid snapshotRevision required' }, 400)
    let gold: Frozen
    try { gold = JSON.parse(await readFile(join(GOLD_DIR, `${rev}.json`), 'utf8')) as Frozen }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return reply({ error: 'Save human-approved Gold Set before running benchmark' }, 409); throw e }
    if (gold.snapshotRevision !== rev || !gold.source || !gold.reference || gold.reference.sourceAlias !== gold.source.alias || !REV.test(gold.source.revisionId) || !REV.test(gold.reference.revisionId) || !gold.facts?.length || !gold.reviewer) throw new Error('Saved Gold Set invalid')
    const selectedInput = typeof body.summaryAlias === 'string' ? body.summaryAlias.trim() : ''
    let summary: string
    let document: string | undefined
    let summaryNote: SummaryNote | undefined
    let model: string
    let provider: string | null
    let finish: string | null = null
    if (selectedInput) {
      const selected = await loadSelectedSummary(selectedInput, gold.source)
      summary = selected.summary
      document = selected.document // Freeze complete original note, including YAML.
      summaryNote = selected.note
      model = selected.note.generatorModel
      provider = null // Existing summary may have been generated by any provider.
    } else {
      // Gold reference/facts are NEVER sent to the summarization model.
      const source = await getOriginal(gold.source.alias, gold.source.revisionId)
      const settings = await readMemexModelSettings()
      if (source.length > settings.maxPromptChars) return reply({ error: `Frozen source exceeds shared maxPromptChars (${source.length} > ${settings.maxPromptChars})` }, 400)
      const url = settings.provider === 'llamacpp' ? `${settings.baseUrl.replace(/\/$/, '')}/chat/completions` : `${settings.baseUrl.replace(/\/$/, '')}/api/chat`
      const messages = [
        { role: 'system', content: 'Summarize the supplied original HedgeDoc faithfully and comprehensively. Preserve all important facts, conditions, exceptions, technical terms and normative force. Do not invent information. Return the summary only.' },
        { role: 'user', content: `=== ORIGINAL HEDGEDOC ===\n${source}\n=== END ORIGINAL ===` },
      ]
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), settings.timeoutSeconds * 1000)
      let r: Response
      try {
        r = await fetch(url, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings.provider === 'llamacpp' ? { model: settings.defaultModel, messages, temperature: settings.temperature, max_tokens: 4096, stream: false } : { model: settings.defaultModel, messages, options: { temperature: settings.temperature, num_ctx: settings.numCtx, num_predict: 4096 }, stream: false }) })
      } finally { clearTimeout(timer) }
      if (!r.ok) throw new Error(`Configured model request failed (HTTP ${r.status}): ${(await r.text()).slice(0, 500)}`)
      const modelResponse = await r.json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; message?: { content?: string }; done_reason?: string }
      const generated = settings.provider === 'llamacpp' ? modelResponse.choices?.[0]?.message?.content : modelResponse.message?.content
      finish = (settings.provider === 'llamacpp' ? modelResponse.choices?.[0]?.finish_reason : modelResponse.done_reason) ?? null
      if (!generated?.trim()) throw new Error('Model returned no summary')
      if (finish === 'length') throw new Error('Model summary truncated; no benchmark result saved')
      summary = generated
      model = settings.defaultModel
      provider = settings.provider
    }
    const id = randomUUID()
    const record = { schemaVersion: 1, runId: id, createdAt: new Date().toISOString(), snapshotRevision: rev,
      source: gold.source, goldReferenceAlias: gold.reference.alias, goldReferenceRevision: gold.reference.revisionId,
      goldFactCount: gold.facts.length, model, provider, summary, finishReason: finish,
      summaryMode: summaryNote ? 'existing' : 'generated',
      ...(summaryNote ? { sourceSummary: summaryNote, summaryDocument: document } : {}),
      status: 'awaiting-model-assessment' }
    await mkdir(RUN_DIR, { recursive: true })
    const path = join(RUN_DIR, `${id}.json`)
    const temp = `${path}.tmp-${process.pid}`
    await writeFile(temp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o640 })
    await rename(temp, path)
    return reply(record)
  } catch (e) { return reply({ error: e instanceof Error ? e.message : String(e) }, 500) }
}
