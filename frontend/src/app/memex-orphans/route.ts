import { NextRequest, NextResponse } from 'next/server'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROOT = '/data/projects/hedgedoc'
const INDEX = `${ROOT}/memex/index.md`
const QUEUE = `${ROOT}/memex/queue.jsonl`
const PID = `${ROOT}/memex/orphan-repair.pid`
const PROCESSOR = `${ROOT}/memex/process_queue_once.py`

interface OrphanItem {
  alias: string
  title: string
  summary: string
}

async function orphans(): Promise<OrphanItem[]> {
  const text = await readFile(INDEX, 'utf8')
  const [beforeTrails, trails = ''] = text.split('## Trails', 2)
  const sources = beforeTrails.split('## Sources', 2)[1] ?? ''

  const items: OrphanItem[] = []
  const linked = new Set<string>()

  const rx = /^- \[([^\]]+)\]\([^)]*\/n\/([^?#)]+)[^)]*\)(?: — (.*))?$/gm
  let match: RegExpExecArray | null

  while ((match = rx.exec(sources)) !== null) {
    items.push({
      title: match[1],
      alias: match[2],
      summary: match[3] ?? ''
    })
  }

  rx.lastIndex = 0
  while ((match = rx.exec(trails)) !== null) {
    linked.add(match[2])
  }

  return items.filter((item) => !linked.has(item.alias))
}

async function running(): Promise<boolean> {
  try {
    const pid = Number((await readFile(PID, 'utf8')).trim())
    if (!pid) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function GET(request: NextRequest) {
  const q = (request.nextUrl.searchParams.get('q') ?? '').toLowerCase()
  let items = await orphans()

  if (q) {
    items = items.filter((item) => `${item.title} ${item.alias} ${item.summary}`.toLowerCase().includes(q))
  }

  return NextResponse.json({
    items,
    count: items.length,
    running: await running()
  })
}

export async function POST() {
  const items = await orphans()

  if (items.length === 0) {
    return NextResponse.json({ started: false, count: 0 })
  }

  if (await running()) {
    return NextResponse.json({ started: false, running: true, count: items.length })
  }

  const now = new Date().toISOString()
  const target = items[0].alias

  await appendFile(
    QUEUE,
    JSON.stringify({
      id: randomUUID(),
      alias: target,
      queuedAt: now,
      status: 'pending',
      queueReason: 'orphan-repair',
      repairTargets: items.map((item) => item.alias)
    }) + '\n',
    'utf8'
  )

  const child = spawn('python3', [PROCESSOR], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: process.env
  })

  child.unref()
  await writeFile(PID, String(child.pid), 'utf8')

  return NextResponse.json({ started: true, target, count: items.length, pid: child.pid }, { status: 202 })
}
