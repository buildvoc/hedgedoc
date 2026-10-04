import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEDGEDOC_ROOT =
  process.env.MEMEX_HEDGEDOC_ROOT ?? '/data/projects/hedgedoc'

const NODEBOOK_ROOT =
  process.env.MEMEX_NODEBOOK_ROOT ?? '/data/projects/hedgedoc-nb-frontend'

const SNAPSHOT_ROOT =
  process.env.MEMEX_RESET_SNAPSHOT_DIR ??
  path.join(HEDGEDOC_ROOT, 'memex', 'data-snapshots')

const INDEX_PATH =
  process.env.MEMEX_INDEX_PATH ?? path.join(HEDGEDOC_ROOT, 'memex', 'index.md')

const USER_TRAILS_PATH =
  process.env.MEMEX_USER_TRAILS_PATH ??
  path.join(HEDGEDOC_ROOT, 'memex', 'user_trails.jsonl')

const NODEBOOK_DATA_PATH = path.join(NODEBOOK_ROOT, 'data')

const HEDGEDOC_API_BASE =
  process.env.MEMEX_HEDGEDOC_API_BASE ?? 'http://127.0.0.1:3100/api/v2/notes'

const fileExists = async (filename: string): Promise<boolean> => {
  try {
    await stat(filename)
    return true
  } catch {
    return false
  }
}

const safeTimestamp = (): string =>
  new Date().toISOString().replace(/[:.]/g, '-')

const apiHeaders = (): Record<string, string> => {
  const token = process.env.MEMEX_API_TOKEN
  if (!token) {
    throw new Error('MEMEX_API_TOKEN is not configured for the frontend service.')
  }

  return {
    Authorization: `Bearer ${token}`
  }
}

const apiGetNote = async (alias: string): Promise<string> => {
  const response = await fetch(`${HEDGEDOC_API_BASE}/${encodeURIComponent(alias)}/content`, {
    method: 'GET',
    headers: apiHeaders(),
    cache: 'no-store'
  })

  if (!response.ok) {
    throw new Error(`Unable to read ${alias}: HTTP ${response.status}`)
  }

  return response.text()
}

const apiPutNote = async (alias: string, markdown: string): Promise<void> => {
  const response = await fetch(`${HEDGEDOC_API_BASE}/${encodeURIComponent(alias)}`, {
    method: 'PUT',
    headers: {
      ...apiHeaders(),
      'Content-Type': 'text/markdown'
    },
    body: markdown,
    cache: 'no-store'
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(
      `Unable to update ${alias}: HTTP ${response.status}` +
        (detail ? ` ${detail.slice(0, 240)}` : '')
    )
  }
}

const resetIndexTrails = (index: string): string => {
  const trailHeading = '\n## Trails'
  const headingIndex = index.indexOf(trailHeading)

  if (headingIndex >= 0) {
    return `${index.slice(0, headingIndex).trimEnd()}\n\n## Trails\n\nNo trails yet.\n`
  }

  return `${index.trimEnd()}\n\n## Trails\n\nNo trails yet.\n`
}

export async function POST(request: Request) {
  let snapshotDir = ''

  try {
    const body = (await request.json()) as { confirm?: unknown }

    if (body.confirm !== 'RESET') {
      return NextResponse.json(
        { error: 'Reset confirmation is required.' },
        { status: 400 }
      )
    }

    const originalIndex = await readFile(INDEX_PATH, 'utf8')
    const originalUserTrails = (await fileExists(USER_TRAILS_PATH))
      ? await readFile(USER_TRAILS_PATH, 'utf8')
      : undefined

    const [originalIndexMirror, originalNodeBook] = await Promise.all([
      apiGetNote('memex-index'),
      apiGetNote('memex-network')
    ])

    const resetIndex = resetIndexTrails(originalIndex)
    const resetAt = new Date().toISOString()
    const resetNodeBook = [
      '# Memex Network',
      '',
      '```memex',
      'Memex Association Network',
      '```',
      '',
      `<!-- memex-trail-reset:${resetAt} -->`,
      ''
    ].join('\n')

    snapshotDir = path.join(
      SNAPSHOT_ROOT,
      `nodebook-trail-reset-${safeTimestamp()}`
    )
    await mkdir(snapshotDir, { recursive: true })

    await writeFile(
      path.join(snapshotDir, 'memex-index.md'),
      originalIndex,
      'utf8'
    )
    await writeFile(
      path.join(snapshotDir, 'memex-index-mirror.md'),
      originalIndexMirror,
      'utf8'
    )
    await writeFile(
      path.join(snapshotDir, 'memex-network.md'),
      originalNodeBook,
      'utf8'
    )

    if (originalUserTrails !== undefined) {
      await writeFile(
        path.join(snapshotDir, 'user_trails.jsonl'),
        originalUserTrails,
        'utf8'
      )
    }

    if (await fileExists(NODEBOOK_DATA_PATH)) {
      await cp(
        NODEBOOK_DATA_PATH,
        path.join(snapshotDir, 'nodebook-data'),
        { recursive: true, force: false }
      )
    }

    await writeFile(
      path.join(snapshotDir, 'manifest.json'),
      JSON.stringify(
        {
          createdAt: resetAt,
          purpose: 'pre-trail-reset safety snapshot',
          sourceCataloguePreserved: true,
          queueHistoryPreserved: true,
          canonicalAssociationsPreserved: true,
          resetTargets: [
            INDEX_PATH,
            USER_TRAILS_PATH,
            'HedgeDoc note: memex-index',
            'HedgeDoc note: memex-network'
          ],
          snapshotSources: [
            INDEX_PATH,
            USER_TRAILS_PATH,
            NODEBOOK_DATA_PATH,
            'HedgeDoc note: memex-index',
            'HedgeDoc note: memex-network'
          ]
        },
        null,
        2
      ) + '\n',
      'utf8'
    )

    try {
      await writeFile(INDEX_PATH, resetIndex, 'utf8')

      if (originalUserTrails !== undefined) {
        await writeFile(USER_TRAILS_PATH, '', 'utf8')
      }

      await apiPutNote('memex-index', resetIndex)
      await apiPutNote('memex-network', resetNodeBook)
    } catch (error) {
      // Roll back local and mirrored trail state if any reset step fails.
      await writeFile(INDEX_PATH, originalIndex, 'utf8')

      if (originalUserTrails !== undefined) {
        await writeFile(USER_TRAILS_PATH, originalUserTrails, 'utf8')
      }

      try {
        await apiPutNote('memex-index', originalIndexMirror)
      } catch {
        // Preserve the original failure; the filesystem snapshot remains.
      }

      try {
        await apiPutNote('memex-network', originalNodeBook)
      } catch {
        // Preserve the original failure; the filesystem snapshot remains.
      }

      throw error
    }

    return NextResponse.json({
      ok: true,
      snapshot: snapshotDir,
      resetAt,
      preserved: {
        sources: true,
        queueHistory: true,
        canonicalAssociations: true
      }
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        snapshot: snapshotDir || undefined
      },
      { status: 500 }
    )
  }
}
