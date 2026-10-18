import { NextResponse } from 'next/server'
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync
} from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DOCLING_ROOT = process.env.DOCLING_PROJECT_ROOT ?? '/data/projects/docling'
const RUNNER =
  process.env.DOCLING_BATCH_RUNNER ?? `${DOCLING_ROOT}/batch/docling-batch.sh`
const INPUT_DIR =
  process.env.DOCLING_BATCH_INPUT_DIR ?? `${DOCLING_ROOT}/batch/input-pdfs`
const OUTPUT_DIR =
  process.env.DOCLING_BATCH_OUTPUT_DIR ?? `${DOCLING_ROOT}/batch/output-json`
const LOG_DIR = process.env.DOCLING_BATCH_LOG_DIR ?? '/backups/builds'
const LOG_PREFIX = 'docling-batch-'
const LOG_TAIL_BYTES = 64 * 1024

const naturalCompare = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })

const getRunningPids = (): number[] => {
  const result = spawnSync('pgrep', ['-f', RUNNER], { encoding: 'utf8' })
  if (result.status !== 0) return []

  return result.stdout
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0)
}

const listFiles = (directory: string, extension: string): string[] => {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && entry.name.toLowerCase().endsWith(extension.toLowerCase())
      )
      .map((entry) => entry.name)
      .sort(naturalCompare)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

const newestLogPath = (): string | null => {
  try {
    const candidates = readdirSync(LOG_DIR, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith(LOG_PREFIX) &&
          entry.name.endsWith('.log')
      )
      .map((entry) => {
        const path = join(LOG_DIR, entry.name)
        return { path, mtimeMs: statSync(path).mtimeMs }
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)

    return candidates[0]?.path ?? null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const readLogTail = (path: string | null): { logTail: string; logBytes: number } => {
  if (!path) return { logTail: '', logBytes: 0 }

  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const length = Math.min(size, LOG_TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      if (length > 0) {
        readSync(fd, buffer, 0, length, size - length)
      }
      return { logTail: buffer.toString('utf8'), logBytes: size }
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { logTail: '', logBytes: 0 }
    }
    throw error
  }
}

const currentFileFromLog = (logTail: string): string => {
  const matches = Array.from(logTail.matchAll(/^\[\d+\]\s+(.+\.pdf)\s*$/gim))
  return matches.at(-1)?.[1]?.trim() ?? ''
}

const statusPayload = () => {
  const pdfs = listFiles(INPUT_DIR, '.pdf')
  const jsonFiles = listFiles(OUTPUT_DIR, '.json')
  const jsonSet = new Set(jsonFiles)
  const convertedCount = pdfs.filter((pdf) =>
    jsonSet.has(`${pdf.replace(/\.pdf$/i, '')}.json`)
  ).length
  const pids = getRunningPids()
  const logPath = newestLogPath()
  const log = readLogTail(logPath)

  return {
    running: pids.length > 0,
    pids,
    inputCount: pdfs.length,
    convertedCount,
    remainingCount: Math.max(0, pdfs.length - convertedCount),
    currentFile: currentFileFromLog(log.logTail),
    logPath,
    ...log
  }
}

export async function GET() {
  return NextResponse.json(statusPayload())
}

export async function POST() {
  const current = statusPayload()
  if (current.running) {
    return NextResponse.json({ ...current, started: false })
  }

  let runnerStat
  try {
    runnerStat = statSync(RUNNER)
  } catch {
    return NextResponse.json(
      { error: `Docling batch runner is missing: ${RUNNER}` },
      { status: 500 }
    )
  }

  if (!runnerStat.isFile()) {
    return NextResponse.json(
      { error: `Docling batch runner is not a file: ${RUNNER}` },
      { status: 500 }
    )
  }

  mkdirSync(LOG_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = join(LOG_DIR, `${LOG_PREFIX}${stamp}.log`)
  const log = openSync(logPath, 'a')

  const child = spawn(RUNNER, [], {
    cwd: DOCLING_ROOT,
    detached: true,
    env: process.env,
    stdio: ['ignore', log, log]
  })

  closeSync(log)
  child.unref()

  return NextResponse.json(
    {
      ...statusPayload(),
      started: true,
      running: true,
      pid: child.pid,
      logPath
    },
    { status: 202 }
  )
}

export async function DELETE() {
  const pids = getRunningPids()
  const stopped: number[] = []

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
      stopped.push(pid)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }

  return NextResponse.json({ stopped, running: false })
}
