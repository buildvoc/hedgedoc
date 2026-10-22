import { readFile } from 'node:fs/promises'
import { NextResponse } from 'next/server'
import { readMemexApiToken } from '../memex-revisions/_proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MEMEX_INDEX_PATH = '/data/projects/hedgedoc/memex/index.md'
const HEDGEDOC_NOTES_API = 'http://127.0.0.1:3100/api/v2/notes'
const MEMEX_SNAPSHOTS_ALIAS = 'memex-snapshots'
const GOLD_PREFIX = 'memex-gold-summary-'
const NOTE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/i
const GOLD_ALIAS_PATTERN = NOTE_ALIAS_PATTERN

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

// Gold notes are benchmark references, never model-input sources or queue inputs.
interface SnapshotGoldReference extends SnapshotSource {
  sourceAlias: string
  scope: string
}

interface SnapshotManifest {
  schemaVersion?: number
  snapshotType?: string
  name?: string
  createdAt?: string
  sourceCount?: number
  sources?: SnapshotSource[]
  goldReferences?: SnapshotGoldReference[]
}

interface SnapshotBuildMetadata {
  derivedFromSnapshotRevision?: string
  addedSourceAlias?: string
  addedSourceAliases?: string[]
  goldReferences?: SnapshotGoldReference[]
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
    if (source.alias.toLowerCase().startsWith(GOLD_PREFIX)) {
      throw new Error(`Snapshot contains Gold note ${source.alias} as an ORIGINAL source. This revision is unsafe for Wiki Summary evaluation; select a preceding clean source snapshot. No data was changed.`)
    }
  }

  if (manifest.goldReferences !== undefined) {
    if (!Array.isArray(manifest.goldReferences)) {
      throw new Error('Snapshot contains an invalid Gold reference list')
    }
    for (const ref of manifest.goldReferences) {
      if (!ref || typeof ref.alias !== 'string' ||
          !GOLD_ALIAS_PATTERN.test(ref.alias) ||
          typeof ref.title !== 'string' ||
          typeof ref.sourceAlias !== 'string' ||
          !ref.sourceAlias.trim() ||
          typeof ref.scope !== 'string' ||
          typeof ref.revisionId !== 'string') {
        throw new Error('Snapshot contains an invalid Gold reference entry')
      }
      assertRevisionId(ref.revisionId)
      if (!manifest.sources.some((source) => source.alias === ref.sourceAlias)) {
        throw new Error(`Gold reference ${ref.alias} has no original source in snapshot`)
      }
    }
  }

  return manifest
}

// Only read explicit, single-line scalar fields from the frozen HedgeDoc YAML.
// Never infer a source link from a title or from the Gold summary prose.
const goldYamlValue = (markdown: string, key: string): string => {
  const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!fm) return ''
  const row = fm[1].split(/\r?\n/).find((line) => line.startsWith(`${key}:`))
  if (!row) return ''
  const raw = row.slice(key.length + 1).trim()
  if (raw.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw)
      return typeof parsed === 'string' ? parsed.trim() : ''
    } catch { return '' }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replaceAll("''", "'").trim()
  }
  return raw.replace(/\s+#.*$/, '').trim()
}

const fetchGoldReference = async (
  alias: string,
  token: string,
): Promise<SnapshotGoldReference> => {
  if (!GOLD_ALIAS_PATTERN.test(alias)) {
    throw new Error(`Invalid Gold reference alias: ${alias}`)
  }
  const revisionId = await fetchLatestRevisionId(alias, token)
  const markdown = await fetchRevisionContent(alias, revisionId, token)
  const role = goldYamlValue(markdown, 'memex_benchmark_role')
  const sourceAlias = goldYamlValue(markdown, 'memex_benchmark_source_alias')
  const scope = goldYamlValue(markdown, 'memex_benchmark_source_scope')
  const title = goldYamlValue(markdown, 'title') || alias
  if (role !== 'gold-reference' || !sourceAlias || !scope ||
      sourceAlias.startsWith(GOLD_PREFIX)) {
    throw new Error(`Gold note ${alias} needs memex_benchmark_role: gold-reference, memex_benchmark_source_alias and memex_benchmark_source_scope in YAML`)
  }
  return { alias, title, revisionId, sourceAlias, scope }
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
  const goldReferences = metadata.goldReferences ?? []

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
    ...(goldReferences.length > 0 ? { goldReferences } : {}),
  }

  const sourceRows = sources
    .map(
      ({ alias, title, revisionId }) =>
        `| ${title.replaceAll('|', '\\|')} | \`${alias}\` | \`${revisionId}\` |`,
    )
    .join('\n')

  const goldRows = goldReferences.map(({ alias, sourceAlias, revisionId }) =>
    `| \`${alias}\` | \`${sourceAlias}\` | \`${revisionId}\` |`,
  ).join('\n')
  const goldSection = goldReferences.length > 0
    ? `\n## Gold References (benchmark only; never model inputs)\n\n| Gold alias | Original source alias | Frozen revision |\n| --- | --- | --- |\n${goldRows}\n`
    : ''

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

  return `---\ntype: document\ntitle: "Memex Snapshots"\ntags: [memex, snapshots, revisions]\nstatus: workarea\nsnapshot_name: ${yamlString(name)}\nsnapshot_created_at: ${yamlString(createdAt)}\nsnapshot_source_count: ${sources.length}\n${derivedFrontmatter}${addedSourceFrontmatter}---\n\n# Memex Snapshot: ${name}\n\nCreated: ${createdAt}\n\nSources: ${sources.length}\n${derivedBody}${addedSourcesBody}\nThis snapshot contains only the indexed HedgeDoc source set and exact source revisions. Generated trails, associations, and nodeBook data are intentionally excluded.\n\n## Source Manifest\n\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\n## Sources\n\n| Title | Alias | HedgeDoc revision |\n| --- | --- | --- |\n${sourceRows}\n${goldSection}`
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
    const goldReferenceAlias = url.searchParams.get('goldReferenceAlias')?.trim() ?? ''

    if (indexedOnly) {
      // Index discovery is informational. An unindexed HedgeDoc may still be
      // frozen directly by an explicit Extend Snapshot selection.
      const indexedSources = await readFile(MEMEX_INDEX_PATH, 'utf8')
        .then(extractIndexedSources)
        .catch((): IndexedSource[] => [])
      const visibleSources = indexedSources
        .filter((source) => !source.alias.toLowerCase().startsWith(GOLD_PREFIX))
        .sort((left, right) => left.title.localeCompare(right.title))

      return NextResponse.json(
        { sources: visibleSources },
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

    const [indexedSources, token] = await Promise.all([
      readFile(MEMEX_INDEX_PATH, 'utf8')
        .then(extractIndexedSources)
        .catch((): IndexedSource[] => []),
      readMemexApiToken(),
    ])

    const baseContent = await fetchRevisionContent(
      MEMEX_SNAPSHOTS_ALIAS,
      baseRevision,
      token,
    )
    const visibleIndexedSources = indexedSources
      .filter((source) => !source.alias.toLowerCase().startsWith(GOLD_PREFIX))
    const manifest = parseSnapshotManifest(baseContent)
    const baseSources = manifest.sources as SnapshotSource[]
    const baseAliases = new Set(baseSources.map((source) => source.alias.trim()))
    const candidates = visibleIndexedSources
      .filter((source) => !baseAliases.has(source.alias.trim()))
      .sort((left, right) => left.title.localeCompare(right.title))
    const goldReferences = manifest.goldReferences ?? []
    const goldReferencePreview = goldReferenceAlias
      ? await fetchGoldReference(goldReferenceAlias, token)
      : undefined
    // A Gold note can link to an original selected from My Notes even when
    // that original is not indexed. The POST validates the final source list.

    return NextResponse.json(
      {
        baseRevision,
        baseName: manifest.name?.trim() || baseRevision,
        baseSourceCount: baseSources.length,
        baseSourceAliases: [...baseAliases],
        candidates,
        goldReferences,
        ...(goldReferencePreview ? { goldReferencePreview } : {}),
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
      goldReferenceAliases?: unknown
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
    const requestedGoldAliases = Array.isArray(body.goldReferenceAliases)
      ? body.goldReferenceAliases.filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim()).filter(Boolean)
      : []
    const goldReferenceAliases = [...new Set(requestedGoldAliases)]
    const creatingEmptySnapshot = body.empty === true
    const extendingSnapshot = Boolean(baseRevision || sourceAliases.length > 0 || goldReferenceAliases.length > 0)
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

    if (extendingSnapshot && (!baseRevision || (sourceAliases.length === 0 && goldReferenceAliases.length === 0))) {
      return NextResponse.json(
        { error: 'baseRevision and at least one source or Gold reference alias are required to extend a snapshot' },
        { status: 400 },
      )
    }

    if (goldReferenceAliases.length > 100 || goldReferenceAliases.some((alias) => !GOLD_ALIAS_PATTERN.test(alias))) {
      return NextResponse.json(
        { error: 'At most 100 valid HedgeDoc Gold reference aliases can be selected' },
        { status: 400 },
      )
    }

    if (sourceAliases.some((alias) => alias.toLowerCase().startsWith(GOLD_PREFIX))) {
      return NextResponse.json(
        { error: 'Gold notes must be passed as goldReferenceAliases, never as original sources' },
        { status: 400 },
      )
    }

    if (sourceAliases.length > 100 || sourceAliases.some((alias) => !NOTE_ALIAS_PATTERN.test(alias))) {
      return NextResponse.json(
        { error: 'A snapshot extension can add at most 100 HedgeDocs with valid aliases at once' },
        { status: 400 },
      )
    }

    if (baseRevision) {
      assertRevisionId(baseRevision)
    }

    const token = await readMemexApiToken()
    const indexedSources = creatingEmptySnapshot
      ? []
      : extendingSnapshot
        ? await readFile(MEMEX_INDEX_PATH, 'utf8')
          .then(extractIndexedSources)
          .catch((): IndexedSource[] => [])
          .then((sources) => sources.filter((source) => !source.alias.toLowerCase().startsWith(GOLD_PREFIX)))
        : extractIndexedSources(await readFile(MEMEX_INDEX_PATH, 'utf8'))
          .filter((source) => !source.alias.toLowerCase().startsWith(GOLD_PREFIX))
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
      const baseGoldReferences = manifest.goldReferences ?? []
      const baseGoldAliases = new Set(baseGoldReferences.map((ref) => ref.alias))
      const duplicateGoldAliases = goldReferenceAliases.filter((alias) => baseGoldAliases.has(alias))
      if (duplicateGoldAliases.length > 0) {
        return NextResponse.json(
          { error: `Gold reference already attached to snapshot: ${duplicateGoldAliases.join(', ')}` },
          { status: 409 },
        )
      }

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
      // Freeze latest revision of EVERY explicitly selected HedgeDoc, including
      // notes absent from memex/index.md. Never add them to the queue or index.
      const newSources = await Promise.all(
        sourceAliases.map(async (alias) => {
          const revisionId = await fetchLatestRevisionId(alias, token)
          const markdown = await fetchRevisionContent(alias, revisionId, token)
          const role = goldYamlValue(markdown, 'memex_benchmark_role').toLowerCase()
          const pageType = goldYamlValue(markdown, 'memex_page_type').toLowerCase()
          const tags = goldYamlValue(markdown, 'tags').toLowerCase()
          const title = goldYamlValue(markdown, 'title') || indexedByAlias.get(alias)?.title || alias
          if (role === 'gold-reference' || /\bmemex-gold-summary\b/.test(tags) ||
              /^gold reference summary\b/i.test(title)) {
            throw new Error(`Selected note ${alias} is a Gold reference, not an original source. Select its original source and attach this note as a Gold reference.`)
          }
          if (pageType === 'source-summary') {
            throw new Error(`Selected note ${alias} is a generated source-summary, not an original. Select the original HedgeDoc instead.`)
          }
          return { alias, title, revisionId }
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
      const newGoldReferences = await Promise.all(
        goldReferenceAliases.map((alias) => fetchGoldReference(alias, token)),
      )
      for (const reference of newGoldReferences) {
        if (!sources.some((source) => source.alias === reference.sourceAlias)) {
          return NextResponse.json(
            { error: `Gold note ${reference.alias} links to ${reference.sourceAlias}; select that original source on My Notes and add it to this snapshot first (or in the same extension). Indexing is not required.` },
            { status: 400 },
          )
        }
      }
      buildMetadata = {
        derivedFromSnapshotRevision: baseRevision,
        ...(newSources.length === 1 ? { addedSourceAlias: newSources[0].alias } : {}),
        addedSourceAliases: newSources.map((source) => source.alias),
        goldReferences: [...baseGoldReferences, ...newGoldReferences],
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
      goldReferenceCount: buildMetadata.goldReferences?.length ?? 0,
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
