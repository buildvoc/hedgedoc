import { randomUUID } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROOT = '/data/projects/hedgedoc'
const INDEX = `${ROOT}/memex/index.md`
const USER_TRAILS = `${ROOT}/memex/user_trails.jsonl`

interface Source {
  id: number
  alias: string
  title: string
  summary: string
}

interface TrailOption {
  name: string
  reason: string
  members: Array<{
    alias: string
    title: string
  }>
}

function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue

    result[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
  }

  return result
}

function parseIndex(index: string) {
  const sourceSection = index.split('## Sources', 2)[1]?.split('## Trails', 1)[0] ?? ''
  const trailSection = index.split('## Trails', 2)[1] ?? ''

  const sources: Source[] = []
  const rx = /^- \[([^\]]+)\]\([^)]*\/n\/([^?#)]+)[^)]*\)(?: — (.*))?$/gm

  let match: RegExpExecArray | null

  while ((match = rx.exec(sourceSection)) !== null) {
    sources.push({
      id: sources.length + 1,
      title: match[1],
      alias: decodeURIComponent(match[2]),
      summary: match[3] ?? ''
    })
  }

  return { sources, trailSection }
}

function trailSummaries(trailSection: string): string {
  const headings = [...trailSection.matchAll(/^###\s+(.+)$/gm)]

  if (headings.length === 0) return '(none)'

  return headings
    .map((heading, index) => {
      const start = (heading.index ?? 0) + heading[0].length
      const end = headings[index + 1]?.index ?? trailSection.length
      const block = trailSection.slice(start, end)

      const reason =
        block
          .split('\n')
          .map((line) => line.trim())
          .find(
            (line) =>
              line &&
              !line.startsWith('-') &&
              !line.includes('/n/')
          ) ?? ''

      return reason
        ? `- ${heading[1].trim()} — ${reason}`
        : `- ${heading[1].trim()}`
    })
    .join('\n')
}

async function analyze(expression: string) {
  const [index, envText] = await Promise.all([
    readFile(INDEX, 'utf8'),
    readFile(`${ROOT}/.env.memex`, 'utf8')
  ])

  const { trailSection } = parseIndex(index)
  const env = parseEnv(envText)

  const ollama =
    env.MEMEX_OLLAMA_URL ||
    env.OLLAMA_URL ||
    env.OLLAMA_HOST ||
    'http://192.168.1.99:11434'

  const model =
    env.MEMEX_OLLAMA_MODEL ||
    env.OLLAMA_MODEL ||
    'gemma4:26b'

  const existingTrails = trailSummaries(trailSection)


  const prompt = `
You are helping a user create a personal Memex trail.

USER EXPRESSION:
${expression}

EXISTING TRAILS:
${existingTrails}

IMPORTANT:
You are NOT being given the user's existing documents or source pages.
Do NOT invent, infer, select, or mention source documents.
Do NOT force the user's idea into known places, records, buildings, or pages.

First understand the user's intended experience.

Consider:
1. ACTION — what the user wants to do.
2. SUBJECT — what they are interested in.
3. CONTEXT — where/how the experience happens.
4. OUTCOME — what they want from it.
5. PERSONAL EXPERIENCE — memories, places visited, things encountered,
   journeys taken, or places they want to revisit.

Language such as:
- "a place I have been"
- "somewhere I've visited"
- "a place I remember"
- "where I went before"

means PERSONAL PAST EXPERIENCE.

It does NOT mean archaeology, a vanished place, hypothetical history,
or "where something would have been".

EXISTING TRAIL MATCH

An existing trail is a match only when its purpose and activity strongly
match the user's expression.

Topic similarity alone is not enough.

If there is a strong existing match, return:

{
  "existingMatch": {
    "name": "exact existing trail name",
    "reason": "brief explanation",
    "confidence": 0.0
  },
  "options": []
}

Only use existingMatch when confidence is at least 0.85.

Otherwise return EXACTLY TWO different personal trail concepts:

{
  "existingMatch": null,
  "options": [
    {
      "name": "short trail name",
      "reason": "brief interpretation of the user's intent"
    },
    {
      "name": "different short trail name",
      "reason": "brief alternative interpretation"
    }
  ]
}

Rules:
- Preserve the user's activity and personal intent.
- Do not mention or select existing source documents.
- Do not invent places the user did not name.
- Do not assume where the user has been.
- Option 1 should be the closest interpretation.
- Option 2 should be meaningfully different but still plausible.
- Prefer experience-oriented trail names.
- Keep reasons brief.
- Return JSON only.
`.trim()

  const response = await fetch(`${ollama.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      messages: [{ role: 'user', content: prompt }]
    })
  })

  if (!response.ok) {
    throw new Error(`Ollama HTTP ${response.status}`)
  }

  const body = (await response.json()) as {
    message?: { content?: string }
  }

  const raw = JSON.parse(body.message?.content ?? '{}') as {
    existingMatch?: {
      name?: string
      reason?: string
      confidence?: number
    } | null
    options?: Array<{
      name?: string
      reason?: string
    }>
  }

  if (
    raw.existingMatch?.name &&
    (raw.existingMatch.confidence ?? 0) >= 0.85 &&
    trailSection.toLowerCase().includes(raw.existingMatch.name.toLowerCase())
  ) {
    return {
      existingMatch: {
        name: raw.existingMatch.name,
        reason: raw.existingMatch.reason ?? '',
        confidence: raw.existingMatch.confidence
      },
      options: []
    }
  }

  const options: TrailOption[] = (raw.options ?? [])
    .slice(0, 2)
    .map((option) => ({
      name: option.name?.trim() ?? '',
      reason: option.reason?.trim() ?? '',
      members: []
    }))
    .filter((option) => option.name)


  if (options.length !== 2) {
    throw new Error('LLM did not return two valid trail options')
  }

  return {
    existingMatch: null,
    options
  }
}

async function commit(expression: string, option: TrailOption) {
  if (!option.name.trim()) {
    throw new Error('Invalid user trail')
  }

  const record = {
    id: randomUUID(),
    type: 'user-trail',
    origin: 'user',
    status: 'draft',
    nodeBookStatus: 'draft',
    createdAt: new Date().toISOString(),
    expression,
    name: option.name.trim(),
    reason: option.reason.trim(),
    members: []
  }

  await appendFile(USER_TRAILS, `${JSON.stringify(record)}\n`, 'utf8')

  return record
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      action?: string
      expression?: string
      option?: TrailOption
    }

    const expression = body.expression?.trim() ?? ''

    if (!expression) {
      return NextResponse.json(
        { error: 'Trail expression is required' },
        { status: 400 }
      )
    }

    if (body.action === 'analyze') {
      return NextResponse.json(await analyze(expression))
    }

    if (body.action === 'commit' && body.option) {
      return NextResponse.json({
        committed: await commit(expression, body.option)
      })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}
