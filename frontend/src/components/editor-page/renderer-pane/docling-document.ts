/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type DoclingDocument = Record<string, unknown> & {
  schema_name: 'DoclingDocument'
}

export type DoclingDocumentParseResult =
  | { detected: false; document: null }
  | { detected: true; document: DoclingDocument | null }

const DOCLING_MARKER = /"schema_name"\s*:\s*"DoclingDocument"/

/**
 * Detects a DoclingDocument near the start of the note and extracts its complete JSON object.
 * Prefix text such as a HedgeDoc title is allowed; the stored note is never rewritten.
 */
export const extractDoclingDocument = (lines: string[]): DoclingDocumentParseResult => {
  const head = lines.slice(0, 80).join('\n')
  const headMatch = DOCLING_MARKER.exec(head)

  if (!headMatch) {
    return { detected: false, document: null }
  }

  const source = lines.join('\n')
  const markerMatch = DOCLING_MARKER.exec(source)

  if (!markerMatch) {
    return { detected: true, document: null }
  }

  const start = source.lastIndexOf('{', markerMatch.index)

  if (start < 0) {
    return { detected: true, document: null }
  }

  let depth = 0
  let inString = false
  let escaped = false
  let end = -1

  for (let index = start; index < source.length; index += 1) {
    const char = source[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        end = index + 1
        break
      }
    }
  }

  if (end < 0) {
    return { detected: true, document: null }
  }

  try {
    const parsed = JSON.parse(source.slice(start, end)) as Record<string, unknown>

    if (parsed.schema_name !== 'DoclingDocument') {
      return { detected: true, document: null }
    }

    return { detected: true, document: parsed as DoclingDocument }
  } catch {
    return { detected: true, document: null }
  }
}
