import { execFile } from 'node:child_process'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODEL_HOST =
  process.env.MEMEX_MODEL_CONTROL_HOST ??
  '192.168.1.99'

const MODEL_USER =
  process.env.MEMEX_MODEL_CONTROL_USER ??
  'hp'

const SYSTEMCTL =
  process.env.MEMEX_MODEL_SYSTEMCTL ??
  '/usr/bin/systemctl'

const SERVICES = {
  ollama: {
    label: 'Ollama',
    unit: 'ollama.service'
  },
  llamacpp: {
    label: 'llama.cpp',
    unit: 'memex-llamacpp.service'
  }
} as const

type ServiceKey = keyof typeof SERVICES
type ServiceAction = 'start' | 'stop'

interface RemoteResult {
  ok: boolean
  stdout: string
  stderr: string
}

const sshTarget = `${MODEL_USER}@${MODEL_HOST}`

const runRemote = (
  command: string[]
): Promise<RemoteResult> =>
  new Promise((resolve) => {
    execFile(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=6',
        '-o',
        'StrictHostKeyChecking=accept-new',
        sshTarget,
        ...command
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '')
        })
      }
    )
  })

const serviceStatus = async (
  key: ServiceKey
) => {
  const service = SERVICES[key]
  const result = await runRemote([
    SYSTEMCTL,
    'is-active',
    service.unit
  ])

  const status =
    result.stdout.trim() ||
    (result.ok ? 'unknown' : 'unreachable')

  return {
    key,
    label: service.label,
    unit: service.unit,
    status,
    active: status === 'active'
  }
}

const allStatuses = async () =>
  Promise.all(
    (Object.keys(SERVICES) as ServiceKey[]).map(
      serviceStatus
    )
  )

export async function GET() {
  try {
    const services = await allStatuses()

    return NextResponse.json(
      {
        host: MODEL_HOST,
        services
      },
      {
        headers: {
          'Cache-Control': 'no-store'
        }
      }
    )
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Model service status failed'
      },
      { status: 502 }
    )
  }
}

export async function POST(
  request: NextRequest
) {
  try {
    const body = await request.json()
    const service = String(body.service ?? '')
    const action = String(body.action ?? '')

    if (!(service in SERVICES)) {
      return NextResponse.json(
        { error: 'Unknown model service' },
        { status: 400 }
      )
    }

    if (action !== 'start' && action !== 'stop') {
      return NextResponse.json(
        { error: 'Action must be start or stop' },
        { status: 400 }
      )
    }

    const key = service as ServiceKey
    const safeAction = action as ServiceAction
    const unit = SERVICES[key].unit

    const result = await runRemote([
      'sudo',
      '-n',
      SYSTEMCTL,
      safeAction,
      unit
    ])

    if (!result.ok) {
      const detail =
        result.stderr.trim() ||
        result.stdout.trim() ||
        'remote systemctl failed'

      return NextResponse.json(
        {
          error:
            `${safeAction} ${unit} failed on ` +
            `${MODEL_HOST}: ${detail}`
        },
        { status: 502 }
      )
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 700)
    )

    return NextResponse.json({
      host: MODEL_HOST,
      services: await allStatuses()
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Model service action failed'
      },
      { status: 500 }
    )
  }
}
