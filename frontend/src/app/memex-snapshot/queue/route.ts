import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { NextResponse } from 'next/server'
import { readMemexApiToken } from '../../memex-revisions/_proxy'
import { readMemexModelSettings } from '../../memex-model-settings/_settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QUEUE =
  process.env.MEMEX_QUEUE_PATH ??
  '/data/projects/hedgedoc/memex/queue.jsonl'
const HEDGEDOC_NOTES_API = 'http://127.0.0.1:3100/api/v2/notes'
const MEMEX_SNAPSHOTS_ALIAS = 'memex-snapshots'

interface QueueItem {
  id: string
  alias: string
  queuedAt: string
  status: string
  sourceRevision?: string
  queueReason?: string
  snapshotRevision?: string
  snapshotName?: string
  llmModel?: string
  numCtx?: number
}

interface SnapshotSource {
  alias: string
  title?: string
  revisionId: string
}

interface SnapshotManifest {
  schemaVersion?: number
  snapshotType?: string
  name?: string
  sources?: SnapshotSource[]
}

interface RevisionPayload {
  content?: string
}

const readQueue = async (): Promise<QueueItem[]> => {
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

const writeQueue = async (rows: QueueItem[]): Promise<void> => {
  await mkdir(dirname(QUEUE), { recursive: true })
  await writeFile(
    QUEUE,
    rows.map((row) => JSON.stringify(row)).join('\n') +
      (rows.length ? '\n' : ''),
    'utf8',
  )
}

const assertRevisionId = (revisionId: string): void => {
  if (!/^[0-9a-f-]{16,64}$/i.test(revisionId)) {
    throw new Error('Invalid HedgeDoc revision id')
  }
}

const assertModel = (model: string): void => {
  if (!model || model.length > 160 || !/^[A-Za-z0-9_.:/@+\-]+$/.test(model)) {
    throw new Error('Invalid Ollama model name')
  }
}

const fetchRevisionContent = async (
  alias: string,
  revisionId: string,
  token: string,
): Promise<string> => {
  assertRevisionId(revisionId)

  const response = await fetch(
    `${HEDGEDOC_NOTES_API}/${encodeURIComponent(alias)}/revisions/${encodeURIComponent(revisionId)}`,
    {
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  )

  if (!response.ok) {
    throw new Error(
      `HedgeDoc revision request failed for ${alias} (${response.status})`,
    )
  }

  const revision = (await response.json()) as RevisionPayload
  if (typeof revision.content !== 'string') {
    throw new Error(`HedgeDoc revision ${revisionId} for ${alias} has no content`)
  }

  return revision.content
}

const parseSnapshotManifest = (content: string): SnapshotManifest => {
  const manifestMatch = content.match(
    /## Source Manifest[\s\S]*?```json\s*([\s\S]*?)```/i,
  )

  if (!manifestMatch) {
    throw new Error('Selected revision does not contain a Source Manifest')
  }

  const manifest = JSON.parse(manifestMatch[1]) as SnapshotManifest

  if (
    manifest.snapshotType !== 'memex-source-set' ||
    !Array.isArray(manifest.sources) ||
    manifest.sources.length === 0
  ) {
    throw new Error('Selected revision is not a Memex source snapshot')
  }

  for (const source of manifest.sources) {
    if (
      !source ||
      typeof source.alias !== 'string' ||
      !source.alias.trim() ||
      typeof source.revisionId !== 'string'
    ) {
      throw new Error('Snapshot contains an invalid source entry')
    }
    assertRevisionId(source.revisionId)
  }

  return manifest
}

export async function GET() {
  const settings = await readMemexModelSettings()
  let models = [settings.defaultModel]

  try {
    const response = await fetch(`${settings.baseUrl}/api/tags`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
    if (response.ok) {
      const body = (await response.json()) as {
        models?: Array<{ name?: string; model?: string }>
      }
      const discovered = (body.models ?? [])
        .map((item) => (item.name ?? item.model ?? '').trim())
        .filter(Boolean)

      if (discovered.length > 0) {
        models = Array.from(new Set(discovered)).sort()
      }
    }
  } catch {
    // Snapshot queueing remains usable with the configured default when
    // model discovery is temporarily unavailable.
  }

  if (!models.includes(settings.defaultModel)) {
    models.unshift(settings.defaultModel)
  }

  return NextResponse.json({
    baseUrl: settings.baseUrl,
    defaultModel: settings.defaultModel,
    defaultNumCtx: settings.numCtx,
    models,
  })
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      snapshotRevision?: unknown
      llmModel?: unknown
      numCtx?: unknown
    }

    const snapshotRevision =
      typeof body.snapshotRevision === 'string'
        ? body.snapshotRevision.trim()
        : ''
    const settings = await readMemexModelSettings()
    const llmModel =
      typeof body.llmModel === 'string' && body.llmModel.trim()
        ? body.llmModel.trim()
        : settings.defaultModel
    const requestedNumCtx = Number(body.numCtx)
    const numCtx =
      Number.isInteger(requestedNumCtx) &&
      requestedNumCtx >= 1024 &&
      requestedNumCtx <= 1048576
        ? requestedNumCtx
        : settings.numCtx

    assertRevisionId(snapshotRevision)
    assertModel(llmModel)

    const rows = await readQueue()
    const existingPending = rows.filter((row) => row.status === 'pending')

    if (existingPending.length > 0) {
      return NextResponse.json(
        {
          error:
            'Pending queue is not empty. Process or clear existing Pending items before queueing a snapshot.',
          pendingCount: existingPending.length,
        },
        { status: 409 },
      )
    }

    const token = await readMemexApiToken()
    const snapshotContent = await fetchRevisionContent(
      MEMEX_SNAPSHOTS_ALIAS,
      snapshotRevision,
      token,
    )
    const manifest = parseSnapshotManifest(snapshotContent)
    const sources = manifest.sources as SnapshotSource[]

    // Verify every frozen source revision before changing the queue.
    for (const source of sources) {
      await fetchRevisionContent(source.alias, source.revisionId, token)
    }

    const queuedAt = new Date().toISOString()
    const snapshotName = manifest.name?.trim() || snapshotRevision

    // process_queue_once.py consumes the newest pending row first. Append in
    // reverse so processing follows the source order stored in the snapshot.
    for (const source of [...sources].reverse()) {
      rows.push({
        id: randomUUID(),
        alias: source.alias.trim(),
        queuedAt,
        status: 'pending',
        sourceRevision: source.revisionId,
        queueReason: 'snapshot-process',
        snapshotRevision,
        snapshotName,
        llmModel,
        numCtx,
      })
    }

    await writeQueue(rows)

    return NextResponse.json(
      {
        queued: true,
        sourceCount: sources.length,
        snapshotRevision,
        snapshotName,
        llmModel,
        numCtx,
      },
      { status: 201 },
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Snapshot queueing failed'

    return NextResponse.json(
      { error: message },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    )
  }
}
