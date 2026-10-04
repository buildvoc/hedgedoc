/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DOCLING_SERVE_URL = (process.env.DOCLING_SERVE_URL ?? 'http://127.0.0.1:5001').replace(/\/+$/, '')
const DOCLING_SERVE_API_KEY = process.env.DOCLING_SERVE_API_KEY
const MAX_REQUEST_BYTES = 25 * 1024 * 1024
const MAX_POLLS = 36
const POLL_WAIT_SECONDS = 5

interface DoclingTaskStatus {
  task_id: string
  task_status: string
}

const doclingFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)

  if (DOCLING_SERVE_API_KEY) {
    headers.set('X-Api-Key', DOCLING_SERVE_API_KEY)
  }

  return fetch(`${DOCLING_SERVE_URL}${path}`, {
    ...init,
    headers,
    cache: 'no-store'
  })
}

const readJson = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Docling Serve ${response.status}: ${detail.slice(0, 1000)}`)
  }

  return (await response.json()) as T
}


const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

const fetchRenderedDocument = async (taskId: string): Promise<Record<string, unknown>> => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await doclingFetch(`/v1/result/${encodeURIComponent(taskId)}`)

    if (response.status === 404 && attempt < 3) {
      await sleep(2 ** (attempt + 1) * 1000)
      continue
    }

    const result = await readJson<{
      document?: { json_content?: Record<string, unknown> | null }
    }>(response)
    const renderedDocument = result.document?.json_content

    if (!renderedDocument || renderedDocument.schema_name !== 'DoclingDocument') {
      throw new Error('Docling Serve returned no DoclingDocument JSON result.')
    }

    return renderedDocument
  }

  throw new Error('Docling task completed but its result is not available.')
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get('content-length') ?? '0')

  if (contentLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'DoclingDocument request is too large.' }, { status: 413 })
  }

  try {
    const body = (await request.json()) as { document?: Record<string, unknown> }
    const document = body.document

    if (!document || document.schema_name !== 'DoclingDocument') {
      return NextResponse.json({ error: 'Expected a DoclingDocument JSON object.' }, { status: 400 })
    }

    const source = Buffer.from(JSON.stringify(document), 'utf8').toString('base64')
    const queueResponse = await doclingFetch('/v1/convert/source/async', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sources: [
          {
            kind: 'file',
            filename: 'hedgedoc-docling-document.json',
            base64_string: source
          }
        ],
        options: {
          from_formats: ['json_docling'],
          to_formats: ['json'],
          image_export_mode: 'embedded',
          do_ocr: false
        },
        target: { kind: 'inbody' }
      })
    })

    const queued = await readJson<DoclingTaskStatus>(queueResponse)

    for (let poll = 0; poll < MAX_POLLS; poll += 1) {
      const statusResponse = await doclingFetch(
        `/v1/status/poll/${encodeURIComponent(queued.task_id)}?wait=${POLL_WAIT_SECONDS}`
      )

      if (statusResponse.status === 404) {
        const renderedDocument = await fetchRenderedDocument(queued.task_id)
        return NextResponse.json(
          { document: renderedDocument },
          { headers: { 'Cache-Control': 'no-store' } }
        )
      }

      const status = await readJson<DoclingTaskStatus>(statusResponse)

      if (status.task_status === 'success') {
        const renderedDocument = await fetchRenderedDocument(queued.task_id)
        return NextResponse.json(
          { document: renderedDocument },
          { headers: { 'Cache-Control': 'no-store' } }
        )
      }

      if (status.task_status === 'failure' || status.task_status === 'revoked') {
        throw new Error(`Docling task ${status.task_status}.`)
      }
      await sleep(POLL_WAIT_SECONDS * 1000)
    }

    return NextResponse.json({ error: 'Docling render timed out.' }, { status: 504 })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Docling render failed.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
