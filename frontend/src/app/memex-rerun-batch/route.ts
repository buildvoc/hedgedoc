import { randomUUID } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'

import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type QueueRow = Record<string, unknown>

const QUEUE_PATH =
  process.env.MEMEX_QUEUE_PATH ?? '/data/projects/hedgedoc/memex/queue.jsonl'

const INDEX_PATH =
  process.env.MEMEX_INDEX_PATH ?? '/data/projects/hedgedoc/memex/index.md'

const rowAlias = (row: QueueRow): string | undefined => {
  for (const key of ['source', 'alias', 'noteAlias']) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

const rowStatus = (row: QueueRow): string =>
  typeof row.status === 'string' ? row.status : ''

const queueReason = (row: QueueRow): string =>
  typeof row.queueReason === 'string' ? row.queueReason : ''

const readQueueRows = async (): Promise<QueueRow[]> => {
  let raw = ''
  try {
    raw = await readFile(QUEUE_PATH, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }

  const rows: QueueRow[] = []

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    try {
      const value = JSON.parse(trimmed)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        rows.push(value as QueueRow)
      }
    } catch {
      // Preserve append-only queue behavior: malformed historical lines are
      // ignored for status lookup and are never rewritten by this route.
    }
  }

  return rows
}

const latestNormalRows = (rows: QueueRow[]): Map<string, QueueRow> => {
  const latest = new Map<string, QueueRow>()

  for (const row of rows) {
    const alias = rowAlias(row)
    if (!alias) continue

    // Snapshot replay rows must not become lifecycle/reprocessing authority.
    if (queueReason(row) === 'snapshot-process') continue

    latest.set(alias, row)
  }

  return latest
}

const catalogueAliases = async (): Promise<Set<string>> => {
  const index = await readFile(INDEX_PATH, 'utf8')
  const aliases = new Set<string>()

  const linkPattern = /\/(?:n|p|s)\/([^)\s/"'#?]+)/g
  let match: RegExpExecArray | null

  while ((match = linkPattern.exec(index)) !== null) {
    if (match[1]) aliases.add(decodeURIComponent(match[1]))
  }

  return aliases
}

const pendingAliases = (latest: Map<string, QueueRow>): string[] =>
  Array.from(latest.entries())
    .filter(([, row]) => rowStatus(row) === 'pending')
    .map(([alias]) => alias)

export async function GET() {
  try {
    const rows = await readQueueRows()
    const latest = latestNormalRows(rows)

    return NextResponse.json({
      pending: pendingAliases(latest)
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { aliases?: unknown }
    const requested = Array.isArray(body.aliases)
      ? body.aliases.filter(
          (value): value is string =>
            typeof value === 'string' && value.trim().length > 0
        )
      : []

    const aliases = Array.from(new Set(requested.map((value) => value.trim())))

    if (aliases.length < 1) {
      return NextResponse.json(
        { error: 'Select at least one source.' },
        { status: 400 }
      )
    }

    // Controlled reruns are intentionally limited to four sources at a time.
    if (aliases.length > 4) {
      return NextResponse.json(
        { error: 'Too many sources in one rerun batch; maximum is 4.' },
        { status: 400 }
      )
    }

    const [rows, catalogue] = await Promise.all([
      readQueueRows(),
      catalogueAliases()
    ])
    const latest = latestNormalRows(rows)

    const queued: string[] = []
    const indexRequested: string[] = []
    const skipped: Array<{ alias: string; reason: string }> = []
    const now = new Date().toISOString()
    const outputRows: QueueRow[] = []

    for (const alias of aliases) {
      const base = latest.get(alias)

      if (base && rowStatus(base) === 'pending') {
        skipped.push({ alias, reason: 'already-pending' })
        continue
      }

      // memex/index.md is intentionally scoped while a selected batch runs.
      // Absence from that mutable view must not block the next batch. Queue
      // the source and let the processor materialize/index it automatically.
      if (!catalogue.has(alias)) {
        indexRequested.push(alias)
      }

      const next: QueueRow = base
        ? { ...base }
        : {
            id: randomUUID(),
            alias,
            nodeBook: 'memex-network'
          }

      next.status = 'pending'
      next.queueReason = 'orphan-repair'
      next.queuedAt = now
      next.rerunRequestedAt = now

      // Avoid reusing unique queue-record identifiers if the current queue
      // schema has them. Fresh rows already have a unique id.
      if (base && 'id' in next) next.id = randomUUID()
      if (base && 'queueId' in next) next.queueId = randomUUID()

      // Refresh common timestamp fields only when the existing schema uses
      // them. queuedAt is always added above for auditability.
      if ('createdAt' in next) next.createdAt = now
      if ('updatedAt' in next) next.updatedAt = now
      if ('timestamp' in next) next.timestamp = now

      for (const key of [
        'processedAt',
        'completedAt',
        'cancelledAt',
        'failedAt',
        'error',
        'failure',
        'result'
      ]) {
        delete next[key]
      }

      outputRows.push(next)
      latest.set(alias, next)
      queued.push(alias)
    }

    if (outputRows.length > 0) {
      const text = outputRows.map((row) => JSON.stringify(row)).join('\n') + '\n'
      await appendFile(QUEUE_PATH, text, 'utf8')
    }

    return NextResponse.json({
      queued,
      indexRequested,
      skipped,
      pending: pendingAliases(latest)
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    )
  }
}
