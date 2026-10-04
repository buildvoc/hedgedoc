import { readFile } from 'node:fs/promises'
import { NextRequest, NextResponse } from 'next/server'
import { readMemexModelSettings } from '../memex-model-settings/_settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROOT = '/data/projects/hedgedoc'
const ALLOWED_STATUS = new Set(['draft', 'stable', 'experimental'])

interface Section {
  id: number
  title: string
  anchor: string
  content: string
  ref?: string
  refs?: string[]
  label?: string
}

type JsonObject = Record<string, unknown>

interface Proposal {
  title: string
  reason: string
  sectionIds: number[]
  status?: string
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}

  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (match) {
      env[match[1]] = match[2]
        .trim()
        .replace(/^['"]|['"]$/g, '')
    }
  }

  return env
}

function sourceAlias(value: string): string {
  const input = value.trim()

  const match = input.match(/\/n\/([^/?#]+)/)

  if (match) {
    return decodeURIComponent(match[1])
  }

  return input
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/^n\//, '')
    .split(/[?#]/)[0]
    .trim()
}

function stripFrontmatter(markdown: string): string {
  const text = markdown.replace(/\r\n/g, '\n')

  if (!text.startsWith('---\n')) return text

  const end = text.indexOf('\n---\n', 4)

  if (end === -1) return text

  return text.slice(end + 5)
}

function anchorFor(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[`*_~()[\]{}:;,.!?'"\\/]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function extractTitle(markdown: string): string {
  const frontmatter = markdown.match(
    /^---\n([\s\S]*?)\n---/
  )?.[1]

  const yamlTitle = frontmatter?.match(
    /^title:\s*["']?(.+?)["']?\s*$/m
  )?.[1]

  if (yamlTitle) return yamlTitle.trim()

  const body = stripFrontmatter(markdown)

  return (
    body.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() ??
    'Untitled source note'
  )
}

function extractSections(markdown: string): Section[] {
  const body = stripFrontmatter(markdown)

  // Memex split convention: each H1 heading (# Heading) is a section.
  let matches = [...body.matchAll(/^#\s+(.+?)\s*$/gm)]

  // Fallback for notes that use H2/H3 etc. as their section level.
  if (matches.length < 2) {
    for (let level = 2; level <= 6; level += 1) {
      const marker = '#'.repeat(level)
      const rx = new RegExp(`^${marker}\\s+(.+?)\\s*$`, 'gm')
      const candidate = [...body.matchAll(rx)]

      if (candidate.length >= 2) {
        matches = candidate
        break
      }
    }
  }

  if (matches.length === 0) {
    return [{
      id: 1,
      title: extractTitle(markdown),
      anchor: '',
      content: body.trim()
    }]
  }

  return matches.map((match, index) => {
    const start = match.index ?? 0
    const end = matches[index + 1]?.index ?? body.length
    const title = match[1].trim()

    return {
      id: index + 1,
      title,
      anchor: anchorFor(title),
      content: body.slice(start, end).trim()
    }
  })
}

function isObject(value: unknown): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function refValue(value: unknown): string | undefined {
  if (!isObject(value)) return undefined

  const ref = value.$ref
  return typeof ref === 'string' ? ref : undefined
}

function refList(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  return value
    .map(refValue)
    .filter((ref): ref is string => Boolean(ref))
}

function extractDoclingDocument(markdown: string): JsonObject | null {
  const body = stripFrontmatter(markdown)
  const marker = body.indexOf('\"schema_name\"')

  if (marker < 0) return null

  let start = body.lastIndexOf('{', marker)

  while (start >= 0) {
    try {
      const parsed: unknown = JSON.parse(
        body.slice(start).trim()
      )

      if (
        isObject(parsed) &&
        parsed.schema_name === 'DoclingDocument'
      ) {
        return parsed
      }
    } catch {
      // Keep searching backwards for the top-level JSON object.
    }

    start = body.lastIndexOf('{', start - 1)
  }

  return null
}

function resolveDoclingRef(
  document: JsonObject,
  ref: string
): JsonObject | null {
  const match = ref.match(
    /^#\/([A-Za-z0-9_]+)\/(\d+)$/
  )

  if (!match) return null

  const collection = document[match[1]]
  const index = Number(match[2])

  if (!Array.isArray(collection)) return null

  const node = collection[index]
  return isObject(node) ? node : null
}

function truncateText(
  value: unknown,
  limit = 900
): string | undefined {
  if (typeof value !== 'string') return undefined

  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return undefined

  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}…`
}

function referencedText(
  document: JsonObject,
  refs: string[],
  limit = 1800
): string | undefined {
  const parts: string[] = []
  let length = 0

  for (const ref of refs) {
    const node = resolveDoclingRef(document, ref)
    const text = truncateText(node?.text, 700)

    if (!text) continue

    if (length + text.length > limit) break

    parts.push(`${ref}: ${text}`)
    length += text.length
  }

  return parts.length > 0 ? parts.join(' | ') : undefined
}

function referencedNodes(
  document: JsonObject,
  refs: string[]
): Array<Record<string, unknown>> {
  return refs.slice(0, 40).flatMap((ref) => {
    const node = resolveDoclingRef(document, ref)
    if (!node) return []

    const label =
      typeof node.label === 'string' ? node.label : 'node'
    const text = truncateText(node.text, 320)

    return [{
      ref,
      label,
      ...(typeof node.level === 'number'
        ? { level: node.level }
        : {}),
      ...(text ? { text } : {})
    }]
  })
}

function pageNumbers(node: JsonObject): number[] {
  if (!Array.isArray(node.prov)) return []

  return [
    ...new Set(
      node.prov
        .map((entry) =>
          isObject(entry) && typeof entry.page_no === 'number'
            ? entry.page_no
            : undefined
        )
        .filter((page): page is number => page !== undefined)
    )
  ]
}

function tableText(node: JsonObject): string | undefined {
  const data = node.data
  if (!isObject(data) || !Array.isArray(data.table_cells)) {
    return undefined
  }

  const cells = data.table_cells
    .slice(0, 80)
    .map((cell) =>
      isObject(cell) ? truncateText(cell.text, 160) : undefined
    )
    .filter((text): text is string => Boolean(text))

  return cells.length > 0
    ? truncateText(cells.join(' | '), 2200)
    : undefined
}

function doclingUnitTitle(
  document: JsonObject,
  node: JsonObject,
  ref: string
): string {
  const label =
    typeof node.label === 'string' ? node.label : 'node'

  const text = truncateText(node.text, 120)
  if (text) return text

  const captions = refList(node.captions)
  const captionText = referencedText(
    document,
    captions,
    160
  )

  if (captionText) return `${label}: ${captionText}`

  return `${label} ${ref}`
}

function isDoclingFurnitureNode(node: JsonObject): boolean {
  return node.content_layer === 'furniture'
}

function doclingUnitStructure(
  document: JsonObject,
  node: JsonObject,
  ref: string
): Record<string, unknown> {
  const label =
    typeof node.label === 'string' ? node.label : 'node'
  const children = refList(node.children)
  const captions = refList(node.captions)
  const footnotes = refList(node.footnotes)
  const parent = refValue(node.parent)
  const level =
    typeof node.level === 'number' ? node.level : undefined
  const pages = pageNumbers(node)

  return {
    ref,
    label,
    ...(parent ? { parent } : {}),
    ...(level !== undefined ? { level } : {}),
    ...(truncateText(node.text)
      ? { text: truncateText(node.text) }
      : {}),
    ...(children.length > 0 ? { children } : {}),
    ...(children.length > 0
      ? { childNodes: referencedNodes(document, children) }
      : {}),
    ...(captions.length > 0 ? { captions } : {}),
    ...(footnotes.length > 0 ? { footnotes } : {}),
    ...(pages.length > 0 ? { pages } : {}),
    ...(referencedText(document, children)
      ? { childText: referencedText(document, children) }
      : {}),
    ...(referencedText(document, captions, 800)
      ? { captionText: referencedText(document, captions, 800) }
      : {}),
    ...(tableText(node) ? { tableText: tableText(node) } : {})
  }
}

function extractDoclingUnits(
  document: JsonObject
): Section[] {
  const body = document.body
  if (!isObject(body)) return []

  const units = refList(body.children).flatMap((ref) => {
    const node = resolveDoclingRef(document, ref)
    if (!node || isDoclingFurnitureNode(node)) return []
    return [{ ref, node }]
  })

  return units.map(({ ref, node }, index) => ({
    id: index + 1,
    title: doclingUnitTitle(document, node, ref),
    anchor: '',
    content: JSON.stringify(
      doclingUnitStructure(document, node, ref)
    ),
    ref,
    refs: [ref],
    label:
      typeof node.label === 'string' ? node.label : 'node'
  }))
}

function extractDoclingSections(
  document: JsonObject
): Section[] {
  const body = document.body
  if (!isObject(body)) return []

  const entries = refList(body.children).flatMap((ref) => {
    const node = resolveDoclingRef(document, ref)
    if (!node || isDoclingFurnitureNode(node)) return []
    return [{ ref, node }]
  })

  const headerIndexes = entries.flatMap(
    ({ node }, index) =>
      node.label === 'section_header' ? [index] : []
  )

  // Some DoclingDocuments contain no section_header nodes. Preserve the
  // previous top-level-unit fallback, but exclude furniture from it.
  if (headerIndexes.length === 0) {
    return extractDoclingUnits(document)
  }

  return headerIndexes.map((headerIndex, sectionIndex) => {
    const header = entries[headerIndex]
    const start = sectionIndex === 0 ? 0 : headerIndex
    const end =
      headerIndexes[sectionIndex + 1] ?? entries.length
    const members = entries.slice(start, end)
    const refs = members.map(({ ref }) => ref)
    const title = doclingUnitTitle(
      document,
      header.node,
      header.ref
    )
    const level =
      typeof header.node.level === 'number'
        ? header.node.level
        : undefined

    return {
      id: sectionIndex + 1,
      title,
      anchor: anchorFor(title),
      content: JSON.stringify({
        headerRef: header.ref,
        ...(level !== undefined ? { level } : {}),
        refs,
        units: members.map(({ ref, node }) =>
          doclingUnitStructure(document, node, ref)
        )
      }),
      ref: header.ref,
      refs,
      label: 'section_header'
    }
  })
}

const DOCLING_DROP = Symbol('docling-drop')

function doclingRefIndex(
  document: JsonObject
): Map<string, JsonObject> {
  const index = new Map<string, JsonObject>()

  for (const value of Object.values(document)) {
    if (!Array.isArray(value)) continue

    for (const item of value) {
      if (
        isObject(item) &&
        typeof item.self_ref === 'string'
      ) {
        index.set(item.self_ref, item)
      }
    }
  }

  return index
}

function refsInDoclingValue(
  value: unknown,
  skipParent = true
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      refsInDoclingValue(item, skipParent)
    )
  }

  if (!isObject(value)) return []

  const keys = Object.keys(value)
  if (
    keys.length === 1 &&
    typeof value.$ref === 'string'
  ) {
    return [value.$ref]
  }

  return Object.entries(value).flatMap(([key, child]) => {
    if (key === 'self_ref') return []
    if (skipParent && key === 'parent') return []
    return refsInDoclingValue(child, skipParent)
  })
}

function doclingCollectionKey(
  ref: string
): string | undefined {
  return ref.match(/^#\/([^/]+)\/(\d+)$/)?.[1]
}

function doclingCollectionIndex(ref: string): number {
  const match = ref.match(/^#\/([^/]+)\/(\d+)$/)
  return match ? Number(match[2]) : -1
}

function collectDoclingPageNumbers(
  value: unknown,
  pages: Set<number>
): void {
  if (Array.isArray(value)) {
    value.forEach((item) =>
      collectDoclingPageNumbers(item, pages)
    )
    return
  }

  if (!isObject(value)) return

  if (
    typeof value.page_no === 'number' &&
    Number.isInteger(value.page_no)
  ) {
    pages.add(value.page_no)
  }

  for (const [key, child] of Object.entries(value)) {
    if (key !== 'pages') {
      collectDoclingPageNumbers(child, pages)
    }
  }
}

function filterDoclingPages(
  materialized: JsonObject,
  source: JsonObject
): void {
  const sourcePages = source.pages
  if (!isObject(sourcePages)) return

  const usedPages = new Set<number>()

  for (const [key, value] of Object.entries(materialized)) {
    if (key !== 'pages') {
      collectDoclingPageNumbers(value, usedPages)
    }
  }

  materialized.pages = Object.fromEntries(
    Object.entries(sourcePages).filter(([key]) => {
      const page = Number(key)
      return Number.isInteger(page) && usedPages.has(page)
    })
  )
}

function validateDoclingRefs(document: JsonObject): void {
  const known = new Set(['#/body', '#/furniture'])

  for (const value of Object.values(document)) {
    if (!Array.isArray(value)) continue

    for (const item of value) {
      if (
        isObject(item) &&
        typeof item.self_ref === 'string'
      ) {
        known.add(item.self_ref)
      }
    }
  }

  const dangling = refsInDoclingValue(document, false)
    .filter((ref) => !known.has(ref))

  if (dangling.length > 0) {
    throw new Error(
      `Dangling Docling refs after materialization: ${[
        ...new Set(dangling)
      ].slice(0, 20).join(', ')}`
    )
  }

  const body = document.body
  if (
    !isObject(body) ||
    !Array.isArray(body.children) ||
    body.children.length === 0
  ) {
    throw new Error(
      'Materialized DoclingDocument has no body.children'
    )
  }
}

function materializeDoclingDocument(
  document: JsonObject,
  selectedRefs: string[],
  title: string
): JsonObject {
  const refIndex = doclingRefIndex(document)
  const topLevelRefs = selectedRefs.filter((ref) =>
    refIndex.has(ref)
  )

  if (topLevelRefs.length !== selectedRefs.length) {
    throw new Error(
      'Selected Docling segment contains unresolved body refs'
    )
  }

  if (topLevelRefs.length === 0) {
    throw new Error(
      'Selected Docling segment contains no body refs'
    )
  }

  const include = new Set<string>()
  const queue = [...topLevelRefs]

  while (queue.length > 0) {
    const ref = queue.shift()!
    if (include.has(ref)) continue

    const node = refIndex.get(ref)
    if (!node) continue

    include.add(ref)

    for (const childRef of refsInDoclingValue(node)) {
      if (
        refIndex.has(childRef) &&
        !include.has(childRef)
      ) {
        queue.push(childRef)
      }
    }
  }

  const byCollection = new Map<string, string[]>()

  for (const ref of include) {
    const key = doclingCollectionKey(ref)
    if (!key) continue

    const refs = byCollection.get(key) ?? []
    refs.push(ref)
    byCollection.set(key, refs)
  }

  for (const refs of byCollection.values()) {
    refs.sort(
      (left, right) =>
        doclingCollectionIndex(left) -
        doclingCollectionIndex(right)
    )
  }

  const refMap = new Map<string, string>()

  for (const [key, refs] of byCollection) {
    refs.forEach((oldRef, newIndex) => {
      refMap.set(oldRef, `#/${key}/${newIndex}`)
    })
  }

  const topLevel = new Set(topLevelRefs)

  const rewrite = (
    value: unknown,
    currentOldRef?: string,
    field?: string
  ): unknown | typeof DOCLING_DROP => {
    if (Array.isArray(value)) {
      return value.flatMap((child) => {
        const rewritten = rewrite(
          child,
          currentOldRef,
          field
        )

        return rewritten === DOCLING_DROP
          ? []
          : [rewritten]
      })
    }

    if (!isObject(value)) return value

    const keys = Object.keys(value)

    if (
      keys.length === 1 &&
      typeof value.$ref === 'string'
    ) {
      const oldRef = value.$ref

      if (field === 'parent') {
        if (
          currentOldRef &&
          topLevel.has(currentOldRef)
        ) {
          return { $ref: '#/body' }
        }

        const mappedParent = refMap.get(oldRef)
        if (mappedParent) return { $ref: mappedParent }

        if (
          oldRef === '#/body' ||
          oldRef === '#/furniture'
        ) {
          return { $ref: oldRef }
        }

        return { $ref: '#/body' }
      }

      const mapped = refMap.get(oldRef)
      if (mapped) return { $ref: mapped }

      if (
        oldRef === '#/body' ||
        oldRef === '#/furniture'
      ) {
        return { $ref: oldRef }
      }

      return DOCLING_DROP
    }

    const output: JsonObject = {}

    for (const [key, child] of Object.entries(value)) {
      if (
        key === 'self_ref' &&
        typeof child === 'string'
      ) {
        output[key] =
          refMap.get(child) ?? child
        continue
      }

      const rewritten = rewrite(
        child,
        currentOldRef,
        key
      )

      if (rewritten !== DOCLING_DROP) {
        output[key] = rewritten
      }
    }

    return output
  }

  // Keep source-level metadata by reference, then replace every structural
  // collection with only nodes reachable from this segment.
  const result: JsonObject = {
    ...document,
    name: title
  }

  for (const [key, value] of Object.entries(document)) {
    if (!Array.isArray(value)) continue

    const isNodeCollection = value.some(
      (item) =>
        isObject(item) &&
        typeof item.self_ref === 'string' &&
        doclingCollectionKey(item.self_ref) === key
    )

    if (!isNodeCollection) continue

    result[key] = (byCollection.get(key) ?? []).map(
      (oldRef) => {
        const node = refIndex.get(oldRef)
        if (!node) {
          throw new Error(
            `Missing Docling node during materialization: ${oldRef}`
          )
        }

        const rewritten = rewrite(node, oldRef)
        if (!isObject(rewritten)) {
          throw new Error(
            `Invalid rewritten Docling node: ${oldRef}`
          )
        }

        return rewritten
      }
    )
  }

  const sourceBody = isObject(document.body)
    ? { ...document.body, self_ref: '#/body' }
    : { self_ref: '#/body' }
  const rewrittenBody = rewrite(sourceBody)

  if (!isObject(rewrittenBody)) {
    throw new Error('Could not materialize Docling body')
  }

  rewrittenBody.children = topLevelRefs.map((ref) => ({
    $ref: refMap.get(ref)!
  }))
  result.body = rewrittenBody

  if (isObject(document.furniture)) {
    const originalChildren = Array.isArray(
      document.furniture.children
    )
      ? document.furniture.children
      : []

    const rewrittenFurniture = rewrite({
      ...document.furniture,
      self_ref: '#/furniture'
    })

    if (isObject(rewrittenFurniture)) {
      rewrittenFurniture.children = originalChildren.flatMap(
        (child) => {
          const oldRef = refValue(child)
          const mapped = oldRef
            ? refMap.get(oldRef)
            : undefined

          return mapped ? [{ $ref: mapped }] : []
        }
      )
      result.furniture = rewrittenFurniture
    }
  }

  // The source may contain multi-megabyte page images. Keep only pages
  // actually referenced by provenance in this structural segment.
  filterDoclingPages(result, document)
  validateDoclingRefs(result)

  return result
}

function doclingDerivedNote(
  document: JsonObject,
  title: string,
  description: string,
  sourceUrl: string,
  status: string
): string {
  return [
    '---',
    'type: document',
    'okf_type: Source',
    `title: ${yamlQuote(title)}`,
    `description: ${yamlQuote(description)}`,
    'tags:',
    '  - derived-docling-segment',
    '  - llm-split',
    `status: ${status}`,
    'sources:',
    `  - ${yamlQuote(sourceUrl)}`,
    '---',
    '',
    `# ${title}`,
    '',
    JSON.stringify(document, null, 2),
    ''
  ].join('\n')
}

function yamlQuote(value: string): string {
  return JSON.stringify(
    value.replace(/\r?\n/g, ' ').trim()
  )
}

async function loadEnvironment() {
  return parseEnv(
    await readFile(`${ROOT}/.env.memex`, 'utf8')
  )
}

async function getSource(
  alias: string,
  env: Record<string, string>
): Promise<string> {
  const token = env.MEMEX_API_TOKEN

  if (!token) {
    throw new Error('MEMEX_API_TOKEN missing')
  }

  const api =
    env.MEMEX_HEDGEDOC_API_URL?.replace(/\/$/, '') ??
    'http://127.0.0.1:3100/api/v2'

  const response = await fetch(
    `${api}/notes/${encodeURIComponent(alias)}/content`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      cache: 'no-store'
    }
  )

  if (!response.ok) {
    throw new Error(
      `Source HedgeDoc GET HTTP ${response.status}`
    )
  }

  return response.text()
}

function enforcePromptLimit(
  prompt: string,
  maxChars: number
): string {
  if (prompt.length > maxChars) {
    throw new Error(
      `Split prompt is ${prompt.length} characters; Memex maxPromptChars is ${maxChars}. Increase the setting instead of truncating Docling sections.`
    )
  }

  return prompt
}

async function analyze(
  source: string
) {
  const env = await loadEnvironment()
  const settings = await readMemexModelSettings()
  const alias = sourceAlias(source)

  if (!alias) {
    throw new Error('Source HedgeDoc URL or alias required')
  }

  const markdown = await getSource(alias, env)
  const doclingDocument = extractDoclingDocument(markdown)
  const sourceKind = doclingDocument ? 'docling' : 'markdown'
  const sections = doclingDocument
    ? extractDoclingSections(doclingDocument)
    : extractSections(markdown)

  if (sections.length < 2) {
    throw new Error(
      doclingDocument
        ? 'DoclingDocument does not contain enough semantic sections to split'
        : 'Source note does not contain enough sections to split'
    )
  }

  const ollama = settings.baseUrl
  const model = settings.defaultModel

  const sourceTitle = doclingDocument &&
    typeof doclingDocument.name === 'string'
      ? doclingDocument.name
      : extractTitle(markdown)

  const sectionText = sections
    .map((section) => {
      if (doclingDocument) {
        return `
SECTION ${section.id}
HEADER REF: ${section.ref ?? ''}
BODY REFS: ${(section.refs ?? []).join(', ')}
TYPE: ${section.label ?? 'section'}
TITLE: ${section.title}
STRUCTURE: ${section.content}
`.trim()
      }

      return `
SECTION ${section.id}
TITLE: ${section.title}
ANCHOR: #${section.anchor}

${section.content.slice(0, 4500)}
`.trim()
    })
    .join('\n\n---\n\n')

  const prompt = doclingDocument
    ? `
You are segmenting ONE DoclingDocument into a useful number of
standalone HedgeDocs using its NATIVE DOCUMENT STRUCTURE.

SOURCE TITLE:
${sourceTitle}

DOCLING SEMANTIC SECTIONS IN CANONICAL READING ORDER:

${sectionText}

TASK

Choose semantic segment boundaries from the DoclingDocument tree.
The SECTION order above is derived from section_header boundaries over body.children.
Furniture nodes are excluded. Each SECTION carries the top-level body refs that must move with it.

Return the SMALLEST useful number of coherent standalone notes while
preserving the meaningful document hierarchy.

STRUCTURAL RULES

- section_header nodes define the semantic SECTION boundaries; use level to respect hierarchy.
- group/list nodes stay attached to their surrounding semantic section; their children stay with the group.
- table nodes stay attached to their surrounding semantic section and must not be split internally.
- picture nodes stay attached to their surrounding semantic section; use captions/nearby section context when deciding grouping.
- ordinary text stays in reading order beneath its semantic section.
- child refs and caption refs are structural evidence, not additional SECTION IDs.
- Never convert the document to Markdown for this decision.
- Do not rewrite or summarize source content.
- Do not invent content.
- Every SECTION ID must appear EXACTLY ONCE.
- Never duplicate a SECTION between proposed HedgeDocs.
- Each proposed HedgeDoc must contain a CONTIGUOUS run of SECTION IDs.
- Preserve the canonical SECTION order.
- Produce between 1 and ${Math.min(12, sections.length)} proposed HedgeDocs.
- Give each proposed note a concise standalone title.
- Explain briefly which Docling structural signals justify each segment.

Return SECTION IDs in the field named sectionIds.

Return JSON only:

{
  "summary": "short explanation of the structural segmentation",
  "notes": [
    {
      "title": "New HedgeDoc title",
      "reason": "Docling structural reason for this segment",
      "sectionIds": [1, 2]
    }
  ]
}
`.trim()
    : `
You are deciding how ONE existing HedgeDoc should be divided into
a useful number of NEW standalone HedgeDocs.

SOURCE TITLE:
${sourceTitle}

SOURCE SECTIONS:

${sectionText}

TASK

Decide how many new HedgeDocs are useful.

You decide the number. Do NOT assume one new note per heading.

Related sections may be grouped into one new HedgeDoc.
Distinct topics should become separate HedgeDocs.

Return the SMALLEST useful number of standalone notes while preserving
the meaningful structure of the source.

IMPORTANT

- Do not rewrite or summarize the source text.
- Do not invent content.
- You are ONLY deciding how the original sections are grouped.
- Every section ID must appear EXACTLY ONCE.
- Never duplicate a section between proposed HedgeDocs.
- Keep section order logical.
- Produce between 1 and ${Math.min(12, sections.length)} proposed HedgeDocs.
- Give each proposed note a concise standalone title.
- Explain briefly why those sections belong together.

Return JSON only:

{
  "summary": "short explanation of the split",
  "notes": [
    {
      "title": "New HedgeDoc title",
      "reason": "why these sections belong together",
      "sectionIds": [1, 2]
    }
  ]
}
`.trim()

  const requestPrompt = enforcePromptLimit(
    prompt,
    settings.maxPromptChars
  )

  const response = await fetch(
    `${ollama.replace(/\/$/, '')}/api/chat`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(
        settings.timeoutSeconds * 1000
      ),
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        options: {
          num_ctx: settings.numCtx,
          temperature: settings.temperature
        },
        messages: [
          {
            role: 'user',
            content: requestPrompt
          }
        ]
      })
    }
  )

  if (!response.ok) {
    throw new Error(
      `Ollama HTTP ${response.status}`
    )
  }

  const ollamaResult = await response.json()
  let rawText = String(
    ollamaResult?.message?.content ?? ''
  ).trim()

  rawText = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/, '')

  const raw = JSON.parse(rawText)

  if (!Array.isArray(raw.notes) || raw.notes.length === 0) {
    throw new Error('LLM returned no proposed HedgeDocs')
  }

  const validIds = new Set(
    sections.map((section) => section.id)
  )

  const used = new Set<number>()
  const proposals: Proposal[] = []

  for (const note of raw.notes.slice(0, 12)) {
    const ids = Array.isArray(note.sectionIds)
      ? note.sectionIds
          .map(Number)
          .filter(
            (id: number) =>
              Number.isInteger(id) &&
              validIds.has(id) &&
              !used.has(id)
          )
      : []

    if (ids.length === 0) continue

    ids.sort((a: number, b: number) => a - b)

    if (doclingDocument) {
      for (let index = 1; index < ids.length; index += 1) {
        if (ids[index] !== ids[index - 1] + 1) {
          throw new Error(
            `LLM returned a non-contiguous Docling segment: ${ids.join(', ')}`
          )
        }
      }
    }

    ids.forEach((id: number) => used.add(id))

    proposals.push({
      title:
        String(note.title ?? 'Untitled derived note').trim(),
      reason: String(note.reason ?? '').trim(),
      sectionIds: ids,
      status: 'draft'
    })
  }

  if (used.size !== sections.length) {
    const missing = sections
      .filter((section) => !used.has(section.id))
      .map((section) => section.id)

    throw new Error(
      `LLM split omitted source sections: ${missing.join(', ')}`
    )
  }

  return {
    alias,
    sourceTitle,
    sourceKind,
    canCreate: true,
    sectionCount: sections.length,
    sections: sections.map((section) => ({
      id: section.id,
      title: section.title,
      anchor: section.anchor,
      ref: section.ref,
      refs: section.refs,
      label: section.label
    })),
    summary: String(raw.summary ?? '').trim(),
    proposals
  }
}

async function createNotes(
  source: string,
  proposals: Proposal[],
  previewOnly = false
) {
  const env = await loadEnvironment()
  const alias = sourceAlias(source)

  if (!alias) {
    throw new Error('Source HedgeDoc URL or alias required')
  }

  const markdown = await getSource(alias, env)
  const doclingDocument = extractDoclingDocument(markdown)
  const sections = doclingDocument
    ? extractDoclingSections(doclingDocument)
    : extractSections(markdown)
  const sectionById = new Map(
    sections.map((section) => [section.id, section])
  )

  const token = env.MEMEX_API_TOKEN

  if (!token) {
    throw new Error('MEMEX_API_TOKEN missing')
  }

  const api =
    env.MEMEX_HEDGEDOC_API_URL?.replace(/\/$/, '') ??
    'http://127.0.0.1:3100/api/v2'

  const base =
    (
      env.MEMEX_HEDGEDOC_BASE_URL ??
      'http://192.168.1.142:8180'
    ).replace(/\/$/, '')

  const created: Array<{
    title: string
    status: string
    alias: string
    url: string
  }> = []

  const failures: Array<{
    title: string
    error: string
  }> = []

  const previews: Array<{
    sourceKind: 'markdown' | 'docling'
    title: string
    status: string
    markdown?: string
    document?: JsonObject
  }> = []

  for (const proposal of proposals) {
    try {
      const title = String(proposal.title ?? '').trim()

      if (!title) {
        throw new Error('Title required')
      }

      const status = ALLOWED_STATUS.has(
        String(proposal.status)
      )
        ? String(proposal.status)
        : 'draft'

      const ids = [
        ...new Set(
          (proposal.sectionIds ?? [])
            .map(Number)
            .filter((id) => sectionById.has(id))
        )
      ].sort((a, b) => a - b)

      if (ids.length === 0) {
        throw new Error(
          doclingDocument
            ? 'No Docling structural units selected'
            : 'No source sections selected'
        )
      }

      if (doclingDocument) {
        for (let index = 1; index < ids.length; index += 1) {
          if (ids[index] !== ids[index - 1] + 1) {
            throw new Error(
              `Docling creation requires contiguous structural units: ${ids.join(', ')}`
            )
          }
        }
      }

      const selected = ids.map(
        (id) => sectionById.get(id)!
      )

      const description =
        String(proposal.reason ?? '')
          .replace(/\r?\n/g, ' ')
          .trim()

      let derivedMarkdown: string
      let previewDocument: JsonObject | undefined

      if (doclingDocument) {
        const refs = selected.flatMap((section) => {
          const sectionRefs = section.refs ??
            (section.ref ? [section.ref] : [])

          if (sectionRefs.length === 0) {
            throw new Error(
              `Docling semantic section ${section.id} has no body refs`
            )
          }

          return sectionRefs
        })

        const materialized = materializeDoclingDocument(
          doclingDocument,
          refs,
          title
        )
        previewDocument = materialized

        derivedMarkdown = doclingDerivedNote(
          materialized,
          title,
          description,
          `${base}/n/${alias}`,
          status
        )
      } else {
        const sourceUrls = selected.map((section) =>
          section.anchor
            ? `${base}/n/${alias}#${section.anchor}`
            : `${base}/n/${alias}`
        )

        derivedMarkdown = [
          '---',
          'type: document',
          'okf_type: Source',
          `title: ${yamlQuote(title)}`,
          `description: ${yamlQuote(description)}`,
          'tags:',
          '  - derived-section',
          '  - llm-split',
          `status: ${status}`,
          'sources:',
          ...sourceUrls.map(
            (url) => `  - ${yamlQuote(url)}`
          ),
          '---',
          '',
          `# ${title}`,
          '',
          ...selected.flatMap((section) => [
            section.content,
            ''
          ])
        ]
          .join('\n')
          .trimEnd() + '\n'
      }

      if (previewOnly) {
        previews.push({
          sourceKind: doclingDocument
            ? 'docling'
            : 'markdown',
          title,
          status,
          ...(previewDocument
            ? { document: previewDocument }
            : { markdown: derivedMarkdown })
        })
        continue
      }

      const response = await fetch(
        `${api}/notes`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'text/markdown'
          },
          body: derivedMarkdown
        }
      )

      if (!response.ok) {
        throw new Error(
          `HedgeDoc POST HTTP ${response.status}`
        )
      }

      const note = await response.json()

      const newAlias =
        note?.metadata?.primaryAlias

      if (!newAlias) {
        throw new Error(
          'Created note response contained no primaryAlias'
        )
      }

      // Verify that a Docling split persisted as a valid structural document.
      if (doclingDocument) {
        const persisted = await getSource(newAlias, env)
        const persistedDocument =
          extractDoclingDocument(persisted)

        if (!persistedDocument) {
          throw new Error(
            'Created note did not persist a DoclingDocument'
          )
        }

        validateDoclingRefs(persistedDocument)
      }

      created.push({
        title,
        status,
        alias: newAlias,
        url: `${base}/n/${newAlias}`
      })
    } catch (error) {
      failures.push({
        title:
          String(proposal.title ?? 'Untitled'),
        error:
          error instanceof Error
            ? error.message
            : 'Create failed'
      })
    }
  }

  return {
    created,
    failures,
    previews
  }
}

export async function POST(
  request: NextRequest
) {
  try {
    const body = await request.json()

    if (body.action === 'analyze') {
      return NextResponse.json(
        await analyze(String(body.source ?? ''))
      )
    }

    if (body.action === 'preview') {
      const proposal = body.proposal

      if (!proposal || typeof proposal !== 'object') {
        return NextResponse.json(
          { error: 'Proposed HedgeDoc required' },
          { status: 400 }
        )
      }

      const result = await createNotes(
        String(body.source ?? ''),
        [proposal],
        true
      )

      if (result.failures.length > 0) {
        return NextResponse.json(
          { error: result.failures[0].error },
          { status: 400 }
        )
      }

      const preview = result.previews[0]

      if (!preview) {
        return NextResponse.json(
          { error: 'Preview could not be built' },
          { status: 500 }
        )
      }

      return NextResponse.json(preview)
    }

    if (body.action === 'create') {
      const proposals = Array.isArray(body.proposals)
        ? body.proposals
        : []

      if (proposals.length === 0) {
        return NextResponse.json(
          { error: 'No proposed HedgeDocs selected' },
          { status: 400 }
        )
      }

      return NextResponse.json(
        await createNotes(
          String(body.source ?? ''),
          proposals
        )
      )
    }

    return NextResponse.json(
      { error: 'Unknown action' },
      { status: 400 }
    )
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Split operation failed'
      },
      { status: 500 }
    )
  }
}
