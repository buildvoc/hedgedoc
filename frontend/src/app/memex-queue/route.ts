import { NextRequest, NextResponse } from 'next/server'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QUEUE =
  process.env.MEMEX_QUEUE_PATH ??
  '/data/projects/hedgedoc/memex/queue.jsonl'

const MAX_PENDING_SOURCES = 4

interface QueueItem {
  id: string
  alias: string
  sourceUpdatedAt?: string
  queuedAt: string
  status: string
  cancelledAt?: string
  processedAt?: string
  sourceRevision?: string
  nodeBook?: string
  queueReason?: string
  ignoredReason?: string
}

async function readQueue(): Promise<QueueItem[]> {
  try {
    const text = await readFile(QUEUE, 'utf8')
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as QueueItem)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function writeQueue(rows: QueueItem[]) {
  await mkdir(dirname(QUEUE), { recursive: true })
  await writeFile(
    QUEUE,
    rows.map((row) => JSON.stringify(row)).join('\n') +
      (rows.length ? '\n' : ''),
    'utf8'
  )
}

export async function GET(request: NextRequest) {
  const alias = request.nextUrl.searchParams.get('alias')
  const hasQuery = request.nextUrl.searchParams.has('q')
  const q = (request.nextUrl.searchParams.get('q') ?? '').toLowerCase()

  const rows = await readQueue()

  if (alias) {
    const pending = rows.some(
      (row) => row.alias === alias && row.status === 'pending'
    )
    return NextResponse.json({ alias, pending })
  }

  if (hasQuery) {
    const items = rows
      .filter((row) =>
        !q ||
        [
          row.id,
          row.alias,
          row.status,
          row.sourceRevision ?? '',
          row.nodeBook ?? ''
        ].join(' ').toLowerCase().includes(q)
      )
      .slice()
      .reverse()
      .slice(0, 100)

    return NextResponse.json({ items })
  }

  return NextResponse.json({ error: 'alias or q required' }, { status: 400 })
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    alias?: string
    aliases?: string[]
    sourceUpdatedAt?: string
    action?: 'reset-pending'
  }

  const rows = await readQueue()

  if (body.action === 'reset-pending') {
    let count = 0

    for (const row of rows) {
      if (row.status !== 'pending') continue

      row.queueReason = 'orphan-repair'
      delete row.ignoredReason
      delete row.processedAt
      delete row.cancelledAt
      count += 1
    }

    if (count > 0) {
      await writeQueue(rows)
    }

    return NextResponse.json({
      reset: true,
      count,
      mode: 'force-reprocess'
    })
  }

  if (body.aliases !== undefined && !Array.isArray(body.aliases)) {
    return NextResponse.json({ error: 'aliases must be an array' }, { status: 400 })
  }

  const requestedAliases = [
    ...(Array.isArray(body.aliases) ? body.aliases : []),
    ...(body.alias ? [body.alias] : [])
  ]
    .map((alias) => String(alias).trim())
    .filter(Boolean)

  const aliases = [...new Set(requestedAliases)]

  if (aliases.length === 0) {
    return NextResponse.json({ error: 'alias or aliases required' }, { status: 400 })
  }

  if (aliases.length > MAX_PENDING_SOURCES) {
    return NextResponse.json(
      {
        error: `Add a maximum of ${MAX_PENDING_SOURCES} sources to Pending at a time`,
        maximum: MAX_PENDING_SOURCES
      },
      { status: 400 }
    )
  }

  const pendingRows = rows.filter((row) => row.status === 'pending')
  const pendingAliases = new Set(pendingRows.map((row) => row.alias))
  const newAliases = aliases.filter((alias) => !pendingAliases.has(alias))
  const availableSlots = Math.max(0, MAX_PENDING_SOURCES - pendingAliases.size)

  if (newAliases.length > availableSlots) {
    return NextResponse.json(
      {
        error:
          `Memex Pending is limited to ${MAX_PENDING_SOURCES} sources. ` +
          `${pendingAliases.size} already pending; ${availableSlots} slot(s) available.`,
        maximum: MAX_PENDING_SOURCES,
        pending: [...pendingAliases],
        availableSlots
      },
      { status: 409 }
    )
  }

  const queuedAt = new Date().toISOString()
  const addedItems: QueueItem[] = newAliases.map((alias) => ({
    id: randomUUID(),
    alias,
    sourceUpdatedAt: aliases.length === 1 ? body.sourceUpdatedAt : undefined,
    queuedAt,
    status: 'pending'
  }))

  if (addedItems.length > 0) {
    rows.push(...addedItems)
    await writeQueue(rows)
  }

  const items = aliases
    .map((alias) =>
      addedItems.find((row) => row.alias === alias) ??
      pendingRows.find((row) => row.alias === alias)
    )
    .filter((row): row is QueueItem => Boolean(row))

  return NextResponse.json(
    {
      pending: true,
      count: aliases.length,
      queued: addedItems.length,
      existing: aliases.length - addedItems.length,
      items,
      item: aliases.length === 1 ? items[0] : undefined,
      maximum: MAX_PENDING_SOURCES
    },
    { status: addedItems.length > 0 ? 201 : 200 }
  )
}

export async function DELETE(request: NextRequest) {
  const body = (await request.json()) as { alias?: string }

  if (!body.alias) {
    return NextResponse.json({ error: 'alias required' }, { status: 400 })
  }

  const rows = await readQueue()
  const cancelledAt = new Date().toISOString()
  let changed = false

  for (const row of rows) {
    if (row.alias === body.alias && row.status === 'pending') {
      row.status = 'cancelled'
      row.cancelledAt = cancelledAt
      changed = true
    }
  }

  if (changed) {
    await writeQueue(rows)
  }

  return NextResponse.json({
    alias: body.alias,
    pending: false,
    cancelled: changed
  })
}
