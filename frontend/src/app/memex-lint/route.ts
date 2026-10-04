import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROOT = '/data/projects/hedgedoc'
const execFileAsync = promisify(execFile)

export async function POST() {
  const envText = await readFile(`${ROOT}/.env.memex`, 'utf8')
  const token =
    envText
      .match(/^MEMEX_API_TOKEN=(.*)$/m)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '') ?? ''

  try {
    const { stdout, stderr } = await execFileAsync('python3', ['memex/lint_memex.py'], {
      cwd: ROOT,
      env: { ...process.env, MEMEX_API_TOKEN: token }
    })

    return NextResponse.json({
      status: stdout.match(/^status:\s*(\w+)/m)?.[1] ?? 'PASS',
      orphanPages: Number(stdout.match(/^orphan pages:\s*(\d+)/m)?.[1] ?? 0),
      output: `${stdout}${stderr}`
    })
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`

    return NextResponse.json({
      status: output.match(/^status:\s*(\w+)/m)?.[1] ?? 'FAIL',
      orphanPages: Number(output.match(/^orphan pages:\s*(\d+)/m)?.[1] ?? 0),
      output
    })
  }
}
