import { NextResponse } from 'next/server'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HD = '/data/projects/hedgedoc'
const RUNNER = `${HD}/memex/process_queue_batch.py`
const LOG = '/tmp/memex-process-queue.log'
const SCOPED_BATCH_MAX = 4

function getMemexEnv(): Record<string, string> {
  const result: Record<string, string> = {}

  const text = readFileSync(`${HD}/.env.memex`, 'utf8')

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#')) continue

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)

    if (!match) continue

    let value = match[2].trim()

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    result[match[1]] = value
  }

  return result
}

function getRunning() {
  const result = spawnSync('pgrep', ['-f', RUNNER], {
    encoding: 'utf8'
  })

  return result.status === 0 && result.stdout.trim().length > 0
}

function normalizeAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    )
  )
}

export async function GET() {
  return NextResponse.json({
    running: getRunning()
  })
}

export async function POST(request: Request) {
  let body: { aliases?: unknown } = {}

  try {
    body = (await request.json()) as { aliases?: unknown }
  } catch {
    // The existing Process Pending button posts no JSON body. Preserve that
    // unscoped queue-drain behaviour when no body is supplied.
  }

  const aliases = normalizeAliases(body.aliases)

  if (aliases.length > SCOPED_BATCH_MAX) {
    return NextResponse.json(
      {
        error: `Scoped Memex processing accepts at most ${SCOPED_BATCH_MAX} aliases.`,
        aliases
      },
      { status: 400 }
    )
  }

  if (getRunning()) {
    return NextResponse.json(
      {
        started: false,
        running: true,
        aliases
      },
      aliases.length > 0 ? { status: 409 } : undefined
    )
  }

  const log = openSync(LOG, 'a')
  const memexEnv = getMemexEnv()

  if (aliases.length > 0) {
    memexEnv.MEMEX_PROCESS_BATCH_ALIASES = JSON.stringify(aliases)
  }

  const child = spawn('python3', [RUNNER], {
    cwd: HD,
    env: { ...process.env, ...memexEnv },
    detached: true,
    stdio: ['ignore', log, log]
  })

  closeSync(log)
  child.unref()

  return NextResponse.json(
    {
      started: true,
      running: true,
      pid: child.pid,
      aliases
    },
    { status: 202 }
  )
}
