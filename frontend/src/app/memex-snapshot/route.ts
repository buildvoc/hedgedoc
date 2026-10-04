import { readFile } from 'node:fs/promises'
import { NextResponse } from 'next/server'
import { readMemexApiToken } from '../memex-revisions/_proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MEMEX_INDEX_PATH = '/data/projects/hedgedoc/memex/index.md'
const HEDGEDOC_NOTES_API = 'http://127.0.0.1:3100/api/v2/notes'
const MEMEX_SNAPSHOTS_ALIAS = 'memex-snapshots'

interface IndexedSource {
  alias: string
  title: string
}

interface HedgeDocRevisionMetadata {
  uuid: string
  createdAt?: string
}

interface HedgeDocRevisionPayload {
  content?: string
}

interface SnapshotSource extends IndexedSource {
  revisionId: string
}

interface SnapshotManifest {
  schemaVersion?: number
  snapshotType?: string
  name?: string
  createdAt?: string
  sourceCount?: number
  sources?: SnapshotSource[]
}

interface SnapshotBuildMetadata {
  derivedFromSnapshotRevision?: string
  addedSourceAlias?: string
  addedSourceAliases?: string[]
}

const assertRevisionId = (revisionId: string): void => {
  if (!/^[0-9a-f-]{16,64}$/i.test(revisionId)) {
    throw new Error('Invalid HedgeDoc revision id')
  }
}

const extractIndexedSources = (indexText: string): IndexedSource[] => {
  const sourcesMatch = indexText.match(/(?:^|\n)## Sources\s*\n([\s\S]*?)(?=\n##\s|$)/)

  if (!sourcesMatch) {
    throw new Error('Memex index does not contain a ## Sources section')
  }

  const sources: IndexedSource[] = []

  for (const line of sourcesMatch[1].split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+\[([^\]]+)\]\([^)]*\/n\/([^/?#)]+)[^)]*\)/)
    if (!match) continue

    sources.push({
      title: match[1].trim(),
      alias: decodeURIComponent(match[2].trim()),
    })
  }

  if (sources.length === 0) {
    throw new Error('Memex index ## Sources section contains no source links')
  }

  return sources
}

const fetchLatestRevisionId = async (
  alias: string,
  token: string,
): Promise<string> => {
  const response = await fetch(
    `${HEDGEDOC_NOTES_API}/${encodeURIComponent(alias)}/revisions`,
    {
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  )

  if (!response.ok) {
    throw new Error(
      `HedgeDoc revisions request failed for ${alias} (${response.status})`,
    )
  }

  const revisions = (await response.json()) as HedgeDocRevisionMetadata[]

  if (!Array.isArray(revisions) || revisions.length === 0) {
    throw new Error(`HedgeDoc returned no revisions for ${alias}`)
  }

  const latest = [...revisions].sort((left, right) => {
    const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0
    const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0
    return rightTime - leftTime
  })[0]

  if (!latest?.uuid) {
    throw new Error(`Latest HedgeDoc revision for ${alias} has no id`)
  }

  return latest.uuid
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

  const revision = (await response.json()) as HedgeDocRevisionPayload
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
    !Array.isArray(manifest.sources)
  ) {
    throw new Error('Selected revision is not a Memex source snapshot')
  }

  for (const source of manifest.sources) {
    if (
      !source ||
      typeof source.alias !== 'string' ||
      !source.alias.trim() ||
      typeof source.title !== 'string' ||
      typeof source.revisionId !== 'string'
    ) {
      throw new Error('Snapshot contains an invalid source entry')
    }
    assertRevisionId(source.revisionId)
  }

  return manifest
}

const yamlString = (value: string): string => JSON.stringify(value)

const buildSnapshotMarkdown = (
  name: string,
  createdAt: string,
  sources: SnapshotSource[],
  metadata: SnapshotBuildMetadata = {},
): string => {
  const addedSourceAliases = metadata.addedSourceAliases ??
    (metadata.addedSourceAlias ? [metadata.addedSourceAlias] : [])

  const manifest = {
    schemaVersion: 1,
    snapshotType: 'memex-source-set',
    name,
    createdAt,
    sourceCount: sources.length,
    ...(metadata.derivedFromSnapshotRevision
      ? { derivedFromSnapshotRevision: metadata.derivedFromSnapshotRevision }
      : {}),
    ...(addedSourceAliases.length === 1
      ? { addedSourceAlias: addedSourceAliases[0] }
      : {}),
    ...(addedSourceAliases.length > 0
      ? { addedSourceAliases }
      : {}),
    sources: sources.map(({ alias, title, revisionId }) => ({
      alias,
      title,
      revisionId,
    })),
  }

  const sourceRows = sources
    .map(
      ({ alias, title, revisionId }) =>
        `| ${title.replaceAll('|', '\\|')} | \`${alias}\` | \`${revisionId}\` |`,
    )
    .join('\n')

  const derivedFrontmatter = metadata.derivedFromSnapshotRevision
    ? `snapshot_derived_from_revision: ${yamlString(metadata.derivedFromSnapshotRevision)}\n`
    : ''
  const addedSourceFrontmatter = addedSourceAliases.length === 1
    ? `snapshot_added_source_alias: ${yamlString(addedSourceAliases[0])}\n`
    : addedSourceAliases.length > 1
      ? `snapshot_added_source_aliases: ${JSON.stringify(addedSourceAliases)}\n`
      : ''
  const derivedBody = metadata.derivedFromSnapshotRevision
    ? `\nDerived from snapshot revision: \`${metadata.derivedFromSnapshotRevision}\`\n`
    : ''
  const addedSourcesBody = addedSourceAliases.length > 0
    ? `\nAdded source aliases: ${addedSourceAliases.map((alias) => `\`${alias}\``).join(', ')}\n`
    : ''

  return `---\ntype: document\ntitle: "Memex Snapshots"\ntags: [memex, snapshots, revisions]\nstatus: workarea\nsnapshot_name: ${yamlString(name)}\nsnapshot_created_at: ${yamlString(createdAt)}\nsnapshot_source_count: ${sources.length}\n${derivedFrontmatter}${addedSourceFrontmatter}---\n\n# Memex Snapshot: ${name}\n\nCreated: ${createdAt}\n\nSources: ${sources.length}\n${derivedBody}${addedSourcesBody}\nThis snapshot contains only the indexed HedgeDoc source set and exact source revisions. Generated trails, associations, and nodeBook data are intentionally excluded.\n\n## Source Manifest\n\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\n## Sources\n\n| Title | Alias | HedgeDoc revision |\n| --- | --- | --- |\n${sourceRows}\n`
}

const updateSnapshotsNote = async (
  markdown: string,
  token: string,
): Promise<void> => {
  const response = await fetch(
    `${HEDGEDOC_NOTES_API}/${encodeURIComponent(MEMEX_SNAPSHOTS_ALIAS)}`,
    {
      method: 'PUT',
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/markdown',
      },
      body: markdown,
    },
  )

  if (!response.ok) {
    const responseBody = await response.text()
    throw new Error(
      `HedgeDoc snapshot note update failed (${response.status}): ${responseBody.slice(0, 240)}`,
    )
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const baseRevision = url.searchParams.get('baseRevision')?.trim() ?? ''
    const indexedOnly = url.searchParams.get('indexed') === '1'

    if (indexedOnly) {
      const indexText = await readFile(MEMEX_INDEX_PATH, 'utf8')
      const indexedSources = extractIndexedSources(indexText)
        .sort((left, right) => left.title.localeCompare(right.title))

      return NextResponse.json(
        { sources: indexedSources },
        {
          headers: {
            'Cache-Control': 'no-store',
          },
        },
      )
    }

    if (!baseRevision) {
      return NextResponse.json(
        { error: 'baseRevision is required' },
        { status: 400 },
      )
    }

    assertRevisionId(baseRevision)

    const [indexText, token] = await Promise.all([
      readFile(MEMEX_INDEX_PATH, 'utf8'),
      readMemexApiToken(),
    ])

    const baseContent = await fetchRevisionContent(
      MEMEX_SNAPSHOTS_ALIAS,
      baseRevision,
      token,
    )
    const indexedSources = extractIndexedSources(indexText)
    const manifest = parseSnapshotManifest(baseContent)
    const baseSources = manifest.sources as SnapshotSource[]
    const baseAliases = new Set(baseSources.map((source) => source.alias.trim()))
    const candidates = indexedSources
      .filter((source) => !baseAliases.has(source.alias.trim()))
      .sort((left, right) => left.title.localeCompare(right.title))

    return NextResponse.json(
      {
        baseRevision,
        baseName: manifest.name?.trim() || baseRevision,
        baseSourceCount: baseSources.length,
        candidates,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Snapshot extension lookup failed'

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

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown
      baseRevision?: unknown
      sourceAlias?: unknown
      sourceAliases?: unknown
      empty?: unknown
    }
    const requestedName = typeof body.name === 'string' ? body.name.trim() : ''
    const baseRevision =
      typeof body.baseRevision === 'string' ? body.baseRevision.trim() : ''
    const legacySourceAlias =
      typeof body.sourceAlias === 'string' ? body.sourceAlias.trim() : ''
    const requestedSourceAliases = Array.isArray(body.sourceAliases)
      ? body.sourceAliases
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean)
      : legacySourceAlias
        ? [legacySourceAlias]
        : []
    const sourceAliases = [...new Set(requestedSourceAliases)]
    const creatingEmptySnapshot = body.empty === true
    const extendingSnapshot = Boolean(baseRevision || sourceAliases.length > 0)
    const createdAt = new Date().toISOString()
    const name = requestedName || `Snapshot ${createdAt}`

    if (name.length > 120) {
      return NextResponse.json(
        { error: 'Snapshot name must be 120 characters or fewer' },
        { status: 400 },
      )
    }

    if (creatingEmptySnapshot && extendingSnapshot) {
      return NextResponse.json(
        { error: 'empty cannot be combined with baseRevision or source aliases' },
        { status: 400 },
      )
    }

    if (extendingSnapshot && (!baseRevision || sourceAliases.length === 0)) {
      return NextResponse.json(
        { error: 'baseRevision and at least one source alias are required to extend a snapshot' },
        { status: 400 },
      )
    }

    if (sourceAliases.length > 100) {
      return NextResponse.json(
        { error: 'A snapshot extension can add at most 100 HedgeDocs at once' },
        { status: 400 },
      )
    }

    if (baseRevision) {
      assertRevisionId(baseRevision)
    }

    const token = await readMemexApiToken()
    const indexedSources = creatingEmptySnapshot
      ? []
      : extractIndexedSources(await readFile(MEMEX_INDEX_PATH, 'utf8'))
    let sources: SnapshotSource[] = []
    let buildMetadata: SnapshotBuildMetadata = {}

    if (creatingEmptySnapshot) {
      sources = []
    } else if (extendingSnapshot) {
      const baseContent = await fetchRevisionContent(
        MEMEX_SNAPSHOTS_ALIAS,
        baseRevision,
        token,
      )
      const manifest = parseSnapshotManifest(baseContent)
      const baseSources = manifest.sources as SnapshotSource[]
      const existingAliases = new Set(
        baseSources.map((source) => source.alias.trim()),
      )

      const duplicateAliases = sourceAliases.filter((alias) => existingAliases.has(alias))
      if (duplicateAliases.length > 0) {
        return NextResponse.json(
          {
            error: `Selected HedgeDoc${duplicateAliases.length === 1 ? ' is' : 's are'} already present in this snapshot revision: ${duplicateAliases.join(', ')}`,
          },
          { status: 409 },
        )
      }

      const indexedByAlias = new Map(
        indexedSources.map((source) => [source.alias.trim(), source]),
      )
      const missingAliases = sourceAliases.filter((alias) => !indexedByAlias.has(alias))
      if (missingAliases.length > 0) {
        return NextResponse.json(
          {
            error: `Selected HedgeDoc${missingAliases.length === 1 ? ' is' : 's are'} not in the current indexed Memex source set: ${missingAliases.join(', ')}`,
          },
          { status: 400 },
        )
      }

      const newSources = await Promise.all(
        sourceAliases.map(async (alias) => {
          const source = indexedByAlias.get(alias) as IndexedSource
          return {
            ...source,
            revisionId: await fetchLatestRevisionId(source.alias, token),
          }
        }),
      )

      sources = [
        ...baseSources.map((source) => ({
          alias: source.alias.trim(),
          title: source.title,
          revisionId: source.revisionId,
        })),
        ...newSources,
      ]
      buildMetadata = {
        derivedFromSnapshotRevision: baseRevision,
        ...(newSources.length === 1 ? { addedSourceAlias: newSources[0].alias } : {}),
        addedSourceAliases: newSources.map((source) => source.alias),
      }
    } else {
      for (const source of indexedSources) {
        sources.push({
          ...source,
          revisionId: await fetchLatestRevisionId(source.alias, token),
        })
      }
    }

    const markdown = buildSnapshotMarkdown(
      name,
      createdAt,
      sources,
      buildMetadata,
    )
    await updateSnapshotsNote(markdown, token)

    const snapshotRevision = await fetchLatestRevisionId(
      MEMEX_SNAPSHOTS_ALIAS,
      token,
    )

    return NextResponse.json({
      created: true,
      name,
      createdAt,
      sourceCount: sources.length,
      snapshotRevision,
      ...(creatingEmptySnapshot ? { empty: true } : {}),
      ...(buildMetadata.derivedFromSnapshotRevision
        ? {
            derivedFromSnapshotRevision:
              buildMetadata.derivedFromSnapshotRevision,
            addedSourceAlias: buildMetadata.addedSourceAlias,
            addedSourceAliases: buildMetadata.addedSourceAliases,
          }
        : {}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Snapshot creation failed'

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
