import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PROJECT_ROOT = process.env.MEMEX_PROJECT_ROOT ?? '/data/projects/hedgedoc'
const BENCH_DIR = join(PROJECT_ROOT, 'memex/benchmarks/summary')
const RESULTS = join(BENCH_DIR, 'results')
const SCRIPT = join(BENCH_DIR, 'model_summary_benchmark.py')
const SETTINGS = join(PROJECT_ROOT, 'memex/model-settings.json')
const PYTHON = process.env.MEMEX_PYTHON ?? 'python3'
const runIdPattern = /^[0-9a-f-]{36}$/

const respond = (data: unknown, status = 200) => NextResponse.json(data, {
  status,
  headers: { 'Cache-Control': 'no-store' },
})

async function readRun(runId: string) {
  try {
    const text = await readFile(join(RESULTS, `${runId}.json`), 'utf8')
    return JSON.parse(text) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function GET(request: NextRequest) {
  try {
    const runId = request.nextUrl.searchParams.get('runId')
    if (runId !== null) {
      if (!runIdPattern.test(runId)) return respond({ error: 'Invalid run ID' }, 400)
      const run = await readRun(runId)
      return run ? respond(run) : respond({ run: null, state: 'starting' })
    }
    const files = (await readdir(RESULTS).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[]
      throw error
    })).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))
    const runs = await Promise.all(files.sort().reverse().slice(0, 25).map(async (name) => {
      const item = await readRun(name.slice(0, -5))
      return item ? {
        id: item.id,
        status: item.status,
        started_at: item.started_at,
        model: item.model,
        attempts: Array.isArray(item.attempts) ? item.attempts.length : 0,
      } : null
    }))
    return respond({ runs: runs.filter(Boolean), fixture: '64_PAS_9980_FINAL — PAS 9980:2026 page 48', calls: 5 })
  } catch (error) {
    return respond({ error: String(error) }, 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get('origin')
    if (origin && new URL(origin).host !== request.nextUrl.host) {
      return respond({ error: 'Cross-origin benchmark requests are not allowed' }, 403)
    }
    await mkdir(RESULTS, { recursive: true })
    const runId = randomUUID()
    const log = await open(join(RESULTS, `${runId}.log`), 'a')
    let child
    try {
      child = spawn(PYTHON, [SCRIPT, '--settings', SETTINGS, '--results-dir', RESULTS,
        '--run-id', runId, '--max-tokens', '2048', '--temperature', '0.35', '--timeout', '900'], {
        cwd: PROJECT_ROOT,
        env: process.env,
        stdio: ['ignore', log.fd, log.fd],
        detached: true,
      })
      child.unref()
    } finally {
      await log.close()
    }
    if (!child.pid) throw new Error('Cannot start direct-model benchmark')
    return respond({ runId, state: 'starting', pid: child.pid }, 202)
  } catch (error) {
    return respond({ error: String(error) }, 500)
  }
}
