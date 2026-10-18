import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { readMemexApiToken } from '../../memex-revisions/_proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const REV = /^[0-9a-f-]{16,64}$/i
const GOLD_ALIAS = /^memex-gold-summary-[a-z0-9][a-z0-9-]*$/i
const API = process.env.HEDGEDOC_NOTES_API ?? 'http://127.0.0.1:3100/api/v2/notes'
const PROJECT = process.env.MEMEX_PROJECT_ROOT ?? '/data/projects/hedgedoc'
const GOLD_DIR = process.env.MEMEX_WIKI_BENCHMARK_GOLD_DIR ?? join(PROJECT, 'memex/benchmarks/summary/gold')

type Source = { alias: string; title: string; revisionId: string }
type Reference = { alias: string; title: string; revisionId: string; sourceAlias: string; scope: string }
type Fact = { id: string; expectation: string }
type Approved = { schemaVersion: number; snapshotRevision: string; source: Source; reference: Reference; referenceSha256?: string; facts: Fact[]; reviewer: string; reviewedAt: string }

const send = (obj: unknown, status = 200) => NextResponse.json(obj, { status, headers: { 'Cache-Control': 'no-store' } })
const fileFor = (rev: string) => join(GOLD_DIR, `${rev}.json`)
const revisionContent = async (alias: string, rev: string, token: string): Promise<string> => {
  if (!REV.test(rev)) throw new Error('Invalid revision ID')
  const r = await fetch(`${API}/${encodeURIComponent(alias)}/revisions/${encodeURIComponent(rev)}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
  })
  if (!r.ok) throw new Error(`HedgeDoc revision ${alias} failed (${r.status})`)
  const value = (await r.json()) as { content?: unknown }
  if (typeof value.content !== 'string') throw new Error('Revision content missing')
  return value.content
}
const load = async (revision: string) => {
  if (!REV.test(revision)) throw new Error('Invalid snapshotRevision')
  const token = await readMemexApiToken()
  const text = await revisionContent('memex-snapshots', revision, token)
  const match = text.match(/## Source Manifest[\s\S]*?```json\s*([\s\S]*?)```/i)
  if (!match) throw new Error('Source Manifest missing')
  const manifest = JSON.parse(match[1]) as { snapshotType?: string; sources?: Source[]; goldReferences?: Reference[] }
  if (manifest.snapshotType !== 'memex-source-set' || !Array.isArray(manifest.sources) || !Array.isArray(manifest.goldReferences)) throw new Error('Invalid Gold snapshot')
  if (manifest.sources.length !== 1 || manifest.goldReferences.length !== 1) throw new Error('Expected exactly one original source and one Gold reference')
  const source = manifest.sources[0], reference = manifest.goldReferences[0]
  if (!source || !reference || !GOLD_ALIAS.test(reference.alias) || reference.sourceAlias !== source.alias || source.alias.toLowerCase().startsWith('memex-gold-summary-') || !REV.test(source.revisionId) || !REV.test(reference.revisionId)) throw new Error('Invalid source/Gold association')
  const [original, gold] = await Promise.all([
    revisionContent(source.alias, source.revisionId, token),
    revisionContent(reference.alias, reference.revisionId, token),
  ])
  return { source, reference, original, gold }
}
const saved = async (rev: string): Promise<Approved | null> => {
  try { return JSON.parse(await readFile(fileFor(rev), 'utf8')) as Approved }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err }
}

export async function GET(req: NextRequest) {
  try {
    const rev = req.nextUrl.searchParams.get('snapshotRevision')?.trim() ?? ''
    const selected = await load(rev)
    return send({ snapshotRevision: rev, ...selected, approvedGoldSet: await saved(rev) })
  } catch (err) { return send({ error: err instanceof Error ? err.message : String(err) }, 400) }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { snapshotRevision?: unknown; reviewer?: unknown; facts?: unknown }
    if (typeof body.snapshotRevision !== 'string' || !REV.test(body.snapshotRevision)) throw new Error('Valid snapshotRevision required')
    if (!Array.isArray(body.facts) || body.facts.length < 1 || body.facts.length > 200) throw new Error('Between 1 and 200 human-approved facts required')
    const facts: Fact[] = []
    const seen = new Set<string>()
    for (const row of body.facts) {
      if (!row || typeof row !== 'object') throw new Error('Invalid fact')
      const input = row as Record<string, unknown>
      const id = typeof input.id === 'string' ? input.id.trim() : ''
      const expectation = typeof input.expectation === 'string' ? input.expectation.trim() : ''
      if (!id || id.length > 120 || !expectation || expectation.length > 2000 || seen.has(id)) throw new Error('Invalid or duplicate Gold fact')
      seen.add(id); facts.push({ id, expectation })
    }
    const reviewer = typeof body.reviewer === 'string' ? body.reviewer.trim() : ''
    if (!reviewer || reviewer.length > 120) throw new Error('Human reviewer required')
    const { source, reference } = await load(body.snapshotRevision)
    const approved: Approved = { schemaVersion: 1, snapshotRevision: body.snapshotRevision, source, reference, facts, reviewer, reviewedAt: new Date().toISOString() }
    const path = fileFor(body.snapshotRevision)
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, JSON.stringify(approved, null, 2) + '\n', { flag: 'wx', mode: 0o640 })
    await rename(tmp, path)
    return send({ saved: true, path, goldSet: approved })
  } catch (err) { return send({ error: err instanceof Error ? err.message : String(err) }, 400) }
}
