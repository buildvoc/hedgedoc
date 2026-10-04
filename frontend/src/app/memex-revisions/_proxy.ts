import { readFile } from 'node:fs/promises'

const HEDGEDOC_NOTES_API = 'http://127.0.0.1:3100/api/v2/notes'
const HEDGEDOC_ENV_PATH = '/data/projects/hedgedoc/.env'
const MEMEX_REVISION_ALIASES = new Set(['memex-index', 'memex-log', 'memex-snapshots'])

export const readMemexApiToken = async (): Promise<string> => {
  const processToken = process.env.MEMEX_API_TOKEN?.trim()
  if (processToken) {
    return processToken
  }

  const envText = await readFile(HEDGEDOC_ENV_PATH, 'utf-8')
  const tokenLine = envText
    .split(/\r?\n/)
    .find((line) => /^\s*MEMEX_API_TOKEN\s*=/.test(line))

  if (!tokenLine) {
    throw new Error('MEMEX_API_TOKEN is not configured')
  }

  let token = tokenLine.slice(tokenLine.indexOf('=') + 1).trim()
  if (
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")))
  ) {
    token = token.slice(1, -1)
  }

  if (!token) {
    throw new Error('MEMEX_API_TOKEN is empty')
  }

  return token
}

const assertMemexAlias = (noteAlias: string): void => {
  if (!MEMEX_REVISION_ALIASES.has(noteAlias)) {
    throw new Error('Unsupported Memex revision alias')
  }
}

const assertRevisionId = (revisionId: string): void => {
  if (!/^[0-9a-f-]{16,64}$/i.test(revisionId)) {
    throw new Error('Invalid revision id')
  }
}

export const fetchMemexNoteContent = async (noteAlias: string): Promise<string> => {
  assertMemexAlias(noteAlias)

  const token = await readMemexApiToken()
  const response = await fetch(
    `${HEDGEDOC_NOTES_API}/${encodeURIComponent(noteAlias)}/content`,
    {
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  )

  if (!response.ok) {
    throw new Error(`HedgeDoc note content request failed (${response.status})`)
  }

  return await response.text()
}

export const fetchMemexRevisionApi = async (
  noteAlias: string,
  revisionId?: string,
): Promise<Response> => {
  assertMemexAlias(noteAlias)
  if (revisionId) {
    assertRevisionId(revisionId)
  }

  const token = await readMemexApiToken()
  const suffix = revisionId
    ? `${encodeURIComponent(noteAlias)}/revisions/${encodeURIComponent(revisionId)}`
    : `${encodeURIComponent(noteAlias)}/revisions`

  const response = await fetch(`${HEDGEDOC_NOTES_API}/${suffix}`, {
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  const body = await response.text()

  return new Response(body, {
    status: response.status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': response.headers.get('content-type') ?? 'application/json',
    },
  })
}

export const memexRevisionProxyError = (error: unknown): Response => {
  const message = error instanceof Error ? error.message : 'Memex revision proxy failed'

  return Response.json(
    { error: message },
    {
      status: 500,
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  )
}
