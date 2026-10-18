import { NextResponse } from 'next/server'
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname } from 'node:path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEDGEDOC_ROOT = process.env.MEMEX_HEDGEDOC_ROOT ?? '/data/projects/hedgedoc'
const RUNNER = `${HEDGEDOC_ROOT}/memex/ingest_docling_batch.py`
const OUTPUT_DIR =
  process.env.DOCLING_BATCH_OUTPUT_DIR ?? '/data/projects/docling/batch/output-json'
const MANIFEST_PATH =
  process.env.DOCLING_HEDGEDOC_MANIFEST_PATH ??
  '/data/projects/docling/batch/hedgedoc-ingest.json'
const LOG =
  process.env.DOCLING_HEDGEDOC_INGEST_LOG ??
  '/backups/builds/docling-hedgedoc-ingest.log'
const LOG_TAIL_BYTES = 64 * 1024

interface ManifestItem {
  file?: string
  alias?: string
  title?: string
  jsonSha256?: string
  ingestedAt?: string
  queuedAt?: string
}

interface Manifest {
  version?: number
  items?: Record<string, ManifestItem>
}

const naturalCompare = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })

const getMemexEnv = (): Record<string, string> => {
  const result: Record<string, string> = {}
  const text = readFileSync(`${HEDGEDOC_ROOT}/.env.memex`, 'utf8')

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue

    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    result[match[1]] = value
  }

  return result
}

const getRunningPids = (): number[] => {
  const result = spawnSync('pgrep', ['-f', RUNNER], { encoding: 'utf8' })
  if (result.status !== 0) return []

  return result.stdout
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0)
}

const getLogTail = (): { logTail: string; logBytes: number } => {
  try {
    const fd = openSync(LOG, 'r')
    try {
      const size = fstatSync(fd).size
      const length = Math.min(size, LOG_TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      if (length > 0) {
        readSync(fd, buffer, 0, length, size - length)
      }
      return { logTail: buffer.toString('utf8'), logBytes: size }
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { logTail: '', logBytes: 0 }
    }
    throw error
  }
}

const readManifest = (): Manifest => {
  try {
    const parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
    return parsed && typeof parsed === 'object' ? parsed : { version: 1, items: {} }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, items: {} }
    }
    throw error
  }
}

const writeManifest = (manifest: Manifest): void => {
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true })
  const temp = `${MANIFEST_PATH}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  chmodSync(temp, 0o664)
  renameSync(temp, MANIFEST_PATH)
}

const listReadyJson = (): string[] => {
  try {
    return readdirSync(OUTPUT_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => entry.name)
      .sort(naturalCompare)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

const statusPayload = () => {
  const ready = listReadyJson()
  const manifest = readManifest()
  const items = Object.values(manifest.items ?? {})
    .filter(
      (item): item is Required<Pick<ManifestItem, 'file' | 'alias' | 'title'>> & ManifestItem =>
        typeof item.file === 'string' &&
        typeof item.alias === 'string' &&
        typeof item.title === 'string'
    )
    .sort((left, right) => naturalCompare(left.file, right.file))
  const pids = getRunningPids()

  return {
    running: pids.length > 0,
    pids,
    readyCount: ready.length,
    ingestedCount: items.length,
    queuedCount: items.filter((item) => Boolean(item.queuedAt)).length,
    remainingCount: Math.max(0, ready.length - items.length),
    items,
    ...getLogTail()
  }
}

export async function GET() {
  return NextResponse.json(statusPayload())
}

export async function POST() {
  const current = statusPayload()
  if (current.running) {
    return NextResponse.json({ ...current, started: false })
  }

  if (current.readyCount === 0) {
    return NextResponse.json(
      { error: 'No Docling JSON files are ready for HedgeDoc ingestion.' },
      { status: 409 }
    )
  }

  const memexEnv = getMemexEnv()
  if (!memexEnv.MEMEX_API_TOKEN && !process.env.MEMEX_API_TOKEN) {
    return NextResponse.json(
      { error: 'MEMEX_API_TOKEN is not configured for HedgeDoc batch ingestion.' },
      { status: 500 }
    )
  }

  mkdirSync(dirname(LOG), { recursive: true })
  const log = openSync(LOG, 'a')
  writeSync(log, `\n[docling-ingest] ${new Date().toISOString()} start\n`)

  const child = spawn('python3', [RUNNER], {
    cwd: HEDGEDOC_ROOT,
    detached: true,
    env: { ...process.env, ...memexEnv },
    stdio: ['ignore', log, log]
  })

  closeSync(log)
  child.unref()

  return NextResponse.json(
    {
      ...statusPayload(),
      started: true,
      running: true,
      pid: child.pid
    },
    { status: 202 }
  )
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as { aliases?: unknown }
  if (!Array.isArray(body.aliases)) {
    return NextResponse.json({ error: 'aliases must be an array' }, { status: 400 })
  }

  const aliases = Array.from(
    new Set(
      body.aliases
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
    )
  )

  const manifest = readManifest()
  const queuedAt = new Date().toISOString()
  let marked = 0

  for (const item of Object.values(manifest.items ?? {})) {
    if (item.alias && aliases.includes(item.alias) && !item.queuedAt) {
      item.queuedAt = queuedAt
      marked += 1
    }
  }

  if (marked > 0) writeManifest(manifest)
  return NextResponse.json({ marked, aliases })
}

export async function DELETE() {
  const pids = getRunningPids()
  const stopped: number[] = []

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
      stopped.push(pid)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }

  return NextResponse.json({ stopped, running: false })
}
