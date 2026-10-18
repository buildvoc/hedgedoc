import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { readMemexModelSettings } from '../../memex-model-settings/_settings'
import { readMemexApiToken } from '../../memex-revisions/_proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const REV = /^[0-9a-f-]{16,64}$/i
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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { snapshotRevision?: unknown }
    const rev = typeof body.snapshotRevision === 'string' ? body.snapshotRevision.trim() : ''
    if (!REV.test(rev)) return reply({ error: 'Valid snapshotRevision required' }, 400)
    let gold: Frozen
    try { gold = JSON.parse(await readFile(join(GOLD_DIR, `${rev}.json`), 'utf8')) as Frozen }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return reply({ error: 'Save human-approved Gold Set before running benchmark' }, 409); throw e }
    if (gold.snapshotRevision !== rev || !gold.source || !gold.reference || gold.reference.sourceAlias !== gold.source.alias || !REV.test(gold.source.revisionId) || !REV.test(gold.reference.revisionId) || !gold.facts?.length || !gold.reviewer) throw new Error('Saved Gold Set invalid')
    // The Gold reference and facts are deliberately NEVER sent to the model.
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
    const summary = settings.provider === 'llamacpp' ? modelResponse.choices?.[0]?.message?.content : modelResponse.message?.content
    const finish = settings.provider === 'llamacpp' ? modelResponse.choices?.[0]?.finish_reason : modelResponse.done_reason
    if (!summary?.trim()) throw new Error('Model returned no summary')
    if (finish === 'length') throw new Error('Model summary truncated; no benchmark result saved')
    const id = randomUUID()
    const record = { schemaVersion: 1, runId: id, createdAt: new Date().toISOString(), snapshotRevision: rev, source: gold.source, goldReferenceRevision: gold.reference.revisionId, goldFactCount: gold.facts.length, model: settings.defaultModel, provider: settings.provider, summary, finishReason: finish ?? null, status: 'awaiting-human-review' }
    await mkdir(RUN_DIR, { recursive: true })
    const path = join(RUN_DIR, `${id}.json`)
    const temp = `${path}.tmp-${process.pid}`
    await writeFile(temp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o640 })
    await rename(temp, path)
    return reply(record)
  } catch (e) { return reply({ error: e instanceof Error ? e.message : String(e) }, 500) }
}
