/*
 * SPDX-FileCopyrightText: 2026 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * A small browser-side DoclingDocument -> Markdown adapter.
 *
 * The DoclingDocument body tree is traversed through JSON Pointer references,
 * preserving reading order and hierarchy instead of flattening top-level arrays.
 * Embedded data-URI pictures are returned separately so the caller can upload
 * them to HedgeDoc media storage before inserting the Markdown.
 */

type JsonObject = Record<string, unknown>

export interface EmbeddedDoclingImage {
  placeholder: string
  dataUri: string
  fileName: string
  alt: string
}

export interface DoclingImportResult {
  markdown: string
  embeddedImages: EmbeddedDoclingImage[]
}

interface RenderContext {
  document: JsonObject
  embeddedImages: EmbeddedDoclingImage[]
  visited: Set<string>
  hasTitle: boolean
}

const asObject = (value: unknown): JsonObject | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

const htmlEscape = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const escapeInlineMarkdown = (value: string): string =>
  value.replace(/([\\`*_[\]<>])/g, '\\$1')

const clampHeadingLevel = (value: number): number => Math.max(1, Math.min(6, value))

const pointerValue = (reference: unknown): string | undefined => {
  if (typeof reference === 'string') {
    return reference
  }

  const object = asObject(reference)
  return asString(object?.['$ref']) ?? asString(object?.ref) ?? asString(object?.cref)
}

const decodePointerSegment = (segment: string): string =>
  decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~')

const resolvePointer = (document: JsonObject, pointer: string): unknown => {
  if (pointer === '#') {
    return document
  }
  if (!pointer.startsWith('#/')) {
    return undefined
  }

  let current: unknown = document
  for (const rawSegment of pointer.slice(2).split('/')) {
    const segment = decodePointerSegment(rawSegment)
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined
      }
      current = current[index]
      continue
    }

    const object = asObject(current)
    if (!object || !(segment in object)) {
      return undefined
    }
    current = object[segment]
  }
  return current
}

const childrenOf = (item: JsonObject): unknown[] => asArray(item.children)

const itemText = (item: JsonObject): string =>
  (asString(item.text) ?? asString(item.orig) ?? '').trim()

const formatText = (item: JsonObject): string => {
  const rawText = itemText(item)
  if (!rawText) {
    return ''
  }

  const formatting = asObject(item.formatting)
  let text = escapeInlineMarkdown(rawText)

  if (asBoolean(formatting?.bold)) {
    text = `**${text}**`
  }
  if (asBoolean(formatting?.italic)) {
    text = `*${text}*`
  }
  if (asBoolean(formatting?.strikethrough)) {
    text = `~~${text}~~`
  }
  if (asBoolean(formatting?.underline)) {
    text = `<u>${text}</u>`
  }

  const hyperlink = asString(item.hyperlink)
  return hyperlink ? `[${text}](${hyperlink})` : text
}

const captionText = (item: JsonObject, context: RenderContext): string => {
  for (const captionRef of asArray(item.captions)) {
    const pointer = pointerValue(captionRef)
    if (!pointer) {
      continue
    }
    const caption = asObject(resolvePointer(context.document, pointer))
    if (!caption) {
      continue
    }
    const text = itemText(caption)
    if (text) {
      return text
    }
  }
  return ''
}

const extensionForMimeType = (mimeType: string): string => {
  const subtype = mimeType.split('/')[1]?.toLowerCase() ?? 'bin'
  const cleanSubtype = subtype.split('+')[0]
  if (cleanSubtype === 'jpeg') {
    return 'jpg'
  }
  if (/^[a-z0-9.-]+$/.test(cleanSubtype)) {
    return cleanSubtype
  }
  return 'bin'
}

const renderPicture = (item: JsonObject, context: RenderContext): string => {
  const image = asObject(item.image)
  const uri = asString(image?.uri)
  const caption = captionText(item, context)
  const alt = caption || asString(item.name) || 'Docling picture'

  if (!uri) {
    return `> **Picture:** ${escapeInlineMarkdown(alt)}`
  }

  if (uri.startsWith('data:')) {
    const mimeType = /^data:([^;,]+)/.exec(uri)?.[1] ?? 'application/octet-stream'
    const index = context.embeddedImages.length
    const placeholder = `<!-- HEDGEDOC_DOCLING_IMAGE_${index} -->`
    context.embeddedImages.push({
      placeholder,
      dataUri: uri,
      fileName: `docling-image-${index + 1}.${extensionForMimeType(mimeType)}`,
      alt
    })
    return placeholder
  }

  return `![${escapeInlineMarkdown(alt)}](${uri})`
}

interface TableCell {
  row: number
  col: number
  rowSpan: number
  colSpan: number
  text: string
  header: boolean
}

const tableCellsFromGrid = (grid: unknown[]): TableCell[] => {
  const cells: TableCell[] = []

  grid.forEach((rowValue, rowIndex) => {
    if (!Array.isArray(rowValue)) {
      return
    }

    rowValue.forEach((cellValue, colIndex) => {
      const cell = asObject(cellValue)
      if (!cell) {
        return
      }
      cells.push({
        row: rowIndex,
        col: colIndex,
        rowSpan: 1,
        colSpan: 1,
        text: asString(cell.text) ?? '',
        header:
          asBoolean(cell.column_header) === true ||
          asBoolean(cell.row_header) === true ||
          asBoolean(cell.row_section) === true
      })
    })
  })

  return cells
}

const tableCellsFromOffsets = (values: unknown[]): TableCell[] =>
  values
    .map((cellValue): TableCell | undefined => {
      const cell = asObject(cellValue)
      if (!cell) {
        return undefined
      }

      const row = asNumber(cell.start_row_offset_idx)
      const col = asNumber(cell.start_col_offset_idx)
      if (row === undefined || col === undefined) {
        return undefined
      }

      const endRow = asNumber(cell.end_row_offset_idx) ?? row + 1
      const endCol = asNumber(cell.end_col_offset_idx) ?? col + 1

      return {
        row,
        col,
        rowSpan: Math.max(1, endRow - row),
        colSpan: Math.max(1, endCol - col),
        text: asString(cell.text) ?? '',
        header:
          asBoolean(cell.column_header) === true ||
          asBoolean(cell.row_header) === true ||
          asBoolean(cell.row_section) === true
      }
    })
    .filter((cell): cell is TableCell => cell !== undefined)

const renderTable = (item: JsonObject): string => {
  const data = asObject(item.data)
  if (!data) {
    return '> **Table:** Docling table data is unavailable.'
  }

  const grid = asArray(data.grid)
  const cells =
    grid.length > 0
      ? tableCellsFromGrid(grid)
      : tableCellsFromOffsets(asArray(data.table_cells))

  if (cells.length === 0) {
    return '> **Table:** Docling table cells are unavailable.'
  }

  const rowCount =
    asNumber(data.num_rows) ??
    Math.max(...cells.map((cell) => cell.row + cell.rowSpan))
  const colCount =
    asNumber(data.num_cols) ??
    Math.max(...cells.map((cell) => cell.col + cell.colSpan))

  const starts = new Map<string, TableCell>()
  const covered = new Set<string>()

  for (const cell of cells) {
    starts.set(`${cell.row}:${cell.col}`, cell)
    for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
      for (let col = cell.col; col < cell.col + cell.colSpan; col += 1) {
        if (row !== cell.row || col !== cell.col) {
          covered.add(`${row}:${col}`)
        }
      }
    }
  }

  const rows: string[] = ['<table>', '  <tbody>']

  for (let row = 0; row < rowCount; row += 1) {
    rows.push('    <tr>')
    for (let col = 0; col < colCount; col += 1) {
      const key = `${row}:${col}`
      if (covered.has(key)) {
        continue
      }

      const cell = starts.get(key)
      if (!cell) {
        rows.push('      <td></td>')
        continue
      }

      const tag = cell.header ? 'th' : 'td'
      const rowSpan = cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''
      const colSpan = cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : ''
      rows.push(
        `      <${tag}${rowSpan}${colSpan}>${htmlEscape(cell.text)}</${tag}>`
      )
    }
    rows.push('    </tr>')
  }

  rows.push('  </tbody>', '</table>')
  return rows.join('\n')
}

const renderTextItem = (
  item: JsonObject,
  context: RenderContext,
  listDepth: number
): string => {
  const label = (asString(item.label) ?? 'text').toLowerCase()
  const rawText = itemText(item)

  if (!rawText && !label.startsWith('checkbox')) {
    return ''
  }

  if (label === 'title') {
    return `# ${formatText(item)}`
  }

  if (label === 'section_header') {
    const doclingLevel = asNumber(item.level) ?? 1
    const level = clampHeadingLevel(
      doclingLevel + (context.hasTitle ? 1 : 0)
    )
    return `${'#'.repeat(level)} ${formatText(item)}`
  }

  if (label === 'list_item') {
    const indent = '  '.repeat(listDepth)
    const marker =
      asBoolean(item.enumerated) === true
        ? asString(item.marker)?.trim() || '1.'
        : '-'
    return `${indent}${marker} ${formatText(item)}`
  }

  if (label === 'checkbox_selected') {
    return `${'  '.repeat(listDepth)}- [x] ${formatText(item)}`
  }

  if (label === 'checkbox_unselected') {
    return `${'  '.repeat(listDepth)}- [ ] ${formatText(item)}`
  }

  if (label === 'code') {
    const language =
      asString(item.code_language) ?? asString(item.language) ?? ''
    const fence = rawText.includes('```') ? '````' : '```'
    return `${fence}${language}\n${rawText}\n${fence}`
  }

  if (label === 'formula') {
    return `$$\n${rawText}\n$$`
  }

  if (label === 'caption') {
    return `*${formatText(item)}*`
  }

  if (label === 'footnote') {
    return `> **Footnote:** ${formatText(item)}`
  }

  return formatText(item)
}

const renderChildren = (
  item: JsonObject,
  context: RenderContext,
  listDepth: number
): string[] => {
  const parts: string[] = []

  for (const childRef of childrenOf(item)) {
    const pointer = pointerValue(childRef)
    if (!pointer) {
      continue
    }
    const rendered = renderReference(pointer, context, listDepth)
    if (rendered) {
      parts.push(rendered)
    }
  }

  return parts
}

const renderReference = (
  pointer: string,
  context: RenderContext,
  listDepth: number
): string => {
  if (context.visited.has(pointer)) {
    return ''
  }

  const item = asObject(resolvePointer(context.document, pointer))
  if (!item) {
    return ''
  }

  const contentLayer = asString(item.content_layer)?.toLowerCase()
  if (contentLayer && contentLayer !== 'body') {
    return ''
  }

  context.visited.add(pointer)

  if (pointer.startsWith('#/groups/')) {
    const groupLabel = (asString(item.label) ?? '').toLowerCase()
    const separator = groupLabel === 'list' ? '\n' : '\n\n'
    return renderChildren(item, context, listDepth).join(separator)
  }

  let own = ''

  if (pointer.startsWith('#/texts/')) {
    own = renderTextItem(item, context, listDepth)
  } else if (pointer.startsWith('#/tables/')) {
    own = renderTable(item)
  } else if (pointer.startsWith('#/pictures/')) {
    own = renderPicture(item, context)
  }

  const label = (asString(item.label) ?? '').toLowerCase()
  const childDepth = label === 'list_item' ? listDepth + 1 : listDepth
  const children = renderChildren(item, context, childDepth)

  const separator =
    label === 'list_item' || label.startsWith('checkbox') ? '\n' : '\n\n'
  return [own, ...children].filter(Boolean).join(separator)
}

const hasTitleItem = (document: JsonObject): boolean =>
  asArray(document.texts).some((value) => {
    const item = asObject(value)
    return (asString(item?.label) ?? '').toLowerCase() === 'title'
  })

const sourceComment = (document: JsonObject): string => {
  const name = asString(document.name) ?? 'Untitled'
  const version = asString(document.version) ?? 'unknown'
  const origin = asObject(document.origin)
  const filename = asString(origin?.filename)
  const originText = filename ? ` origin="${filename.replaceAll('"', '&quot;')}"` : ''

  return `<!-- DoclingDocument name="${name.replaceAll('"', '&quot;')}" version="${version}"${originText} -->`
}

/**
 * Converts a serialized DoclingDocument into HedgeDoc-friendly Markdown.
 *
 * The converter requires the body tree because that tree is Docling's reading
 * order. Furniture (page headers/footers) is intentionally not appended to the
 * note body.
 */
export const doclingDocumentToMarkdown = (value: unknown): DoclingImportResult => {
  const document = asObject(value)
  if (!document || asString(document.schema_name) !== 'DoclingDocument') {
    throw new Error('The selected JSON file is not a DoclingDocument.')
  }

  const name = asString(document.name)
  if (!name) {
    throw new Error('The DoclingDocument has no document name.')
  }

  const body = asObject(document.body)
  if (!body) {
    throw new Error('The DoclingDocument has no body tree.')
  }

  const context: RenderContext = {
    document,
    embeddedImages: [],
    visited: new Set<string>(),
    // A single H1 always exists: either a Docling title item or the document name fallback.
    hasTitle: true
  }

  const parts = renderChildren(body, context, 0)
  if (!hasTitleItem(document)) {
    parts.unshift(`# ${escapeInlineMarkdown(name)}`)
  }

  parts.unshift(sourceComment(document))

  return {
    markdown: parts.filter(Boolean).join('\n\n').trim(),
    embeddedImages: context.embeddedImages
  }
}
