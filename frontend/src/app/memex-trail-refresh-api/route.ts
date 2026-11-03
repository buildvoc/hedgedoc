import { spawn } from 'node:child_process'

import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROOT =
  process.env.MEMEX_HEDGEDOC_ROOT ?? '/data/projects/hedgedoc'
const PYTHON =
  process.env.MEMEX_PYTHON ?? 'python3'
const SCRIPT =
  process.env.MEMEX_TRAIL_REFRESH_SCRIPT ??
  `${ROOT}/memex/refresh_trails.py`

interface TrailRefreshRequest {
  action?: unknown
  previewHash?: unknown
  confirmation?: unknown
}

export async function POST(request: NextRequest) {
  let body: TrailRefreshRequest

  try {
    body = (await request.json()) as TrailRefreshRequest
  } catch {
    return new Response('Invalid JSON\n', { status: 400 })
  }

  const action =
    body.action === 'preview'
      ? 'preview'
      : body.action === 'apply'
        ? 'apply'
        : ''

  if (!action) {
    return new Response('action must be preview or apply\n', { status: 400 })
  }

  const previewHash =
    typeof body.previewHash === 'string'
      ? body.previewHash.trim().toLowerCase()
      : ''

  if (action === 'apply' && !/^[0-9a-f]{64}$/.test(previewHash)) {
    return new Response(
      'apply requires the previewHash returned by Generate LLM preview\n',
      { status: 400 }
    )
  }

  if (action === 'apply' && body.confirmation !== 'APPLY') {
    return new Response(
      'apply requires explicit confirmation value APPLY\n',
      { status: 400 }
    )
  }

  const args = [
    SCRIPT,
    '--action',
    action
  ]

  if (action === 'apply') {
    args.push('--preview-hash', previewHash, '--confirmation', 'APPLY')
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const child = spawn(PYTHON, args, {
        cwd: ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      const write = (value: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(value))
        } catch {
          closed = true
        }
      }

      child.stdout.on('data', (chunk) => write(String(chunk)))
      child.stderr.on('data', (chunk) => write(String(chunk)))

      child.on('error', (error) => {
        write(`FATAL: ${error.message}\n`)
      })

      child.on('close', (code) => {
        if (code !== 0) {
          write(`FATAL: trail refresh process exited with code ${code}\n`)
        }

        if (!closed) {
          closed = true
          try {
            controller.close()
          } catch {
            // Client disconnected.
          }
        }
      })

      const abort = () => {
        if (action === 'preview' && child.exitCode === null) {
          child.kill('SIGTERM')
        }
      }

      request.signal.addEventListener('abort', abort, { once: true })
    }
  })

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}
