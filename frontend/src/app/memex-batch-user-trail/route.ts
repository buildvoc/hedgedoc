import { readFile, writeFile } from 'node:fs/promises'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROOT = '/data/projects/hedgedoc'
const USER_TRAILS = `${ROOT}/memex/user_trails.jsonl`

interface BatchNote {
  alias: string
  title: string
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

async function readTrailRows(): Promise<any[]> {
  try {
    return (await readFile(USER_TRAILS, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function cleanTag(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '')
}

function addTags(markdown: string, wantedTags: string[]): string {
  const text = markdown.replace(/\r\n/g, '\n')

  if (!text.startsWith('---\n')) {
    return [
      '---',
      'tags:',
      ...wantedTags.map((tag) => `  - ${tag}`),
      '---',
      text
    ].join('\n')
  }

  const end = text.indexOf('\n---', 4)

  if (end < 0) {
    throw new Error('Malformed YAML frontmatter')
  }

  const frontmatter = text.slice(4, end)
  const rest = text.slice(end)
  const lines = frontmatter.split('\n')

  const tagsIndex = lines.findIndex((line) => /^tags\s*:/.test(line))

  if (tagsIndex < 0) {
    const statusIndex = lines.findIndex((line) => /^status\s*:/.test(line))
    const insertAt = statusIndex >= 0 ? statusIndex : lines.length

    lines.splice(
      insertAt,
      0,
      'tags:',
      ...wantedTags.map((tag) => `  - ${tag}`)
    )

    return `---\n${lines.join('\n')}${rest}`
  }

  const tagLine = lines[tagsIndex]

  // Existing block-list tags:
  //
  // tags:
  //   - one
  //   - two
  if (/^tags\s*:\s*$/.test(tagLine)) {
    let next = tagsIndex + 1

    while (
      next < lines.length &&
      (/^\s+/.test(lines[next]) || lines[next].trim() === '')
    ) {
      next += 1
    }

    const existing = new Set(
      lines
        .slice(tagsIndex + 1, next)
        .map((line) => line.match(/^\s*-\s*(.+?)\s*$/)?.[1])
        .filter((value): value is string => Boolean(value))
        .map(cleanTag)
    )

    const additions = wantedTags
      .filter((tag) => !existing.has(tag))
      .map((tag) => `  - ${tag}`)

    lines.splice(next, 0, ...additions)

    return `---\n${lines.join('\n')}${rest}`
  }

  // Convert inline tags to block form.
  const inline = tagLine.match(/^tags\s*:\s*\[(.*)\]\s*$/)

  if (inline) {
    const existing = inline[1]
      .split(',')
      .map(cleanTag)
      .filter(Boolean)

    const merged = [...new Set([...existing, ...wantedTags])]

    lines.splice(
      tagsIndex,
      1,
      'tags:',
      ...merged.map((tag) => `  - ${tag}`)
    )

    return `---\n${lines.join('\n')}${rest}`
  }

  // Convert a single scalar tag.
  const scalar = tagLine.match(/^tags\s*:\s*(.+?)\s*$/)

  if (scalar) {
    const existing = cleanTag(scalar[1])
    const merged = [...new Set([existing, ...wantedTags].filter(Boolean))]

    lines.splice(
      tagsIndex,
      1,
      'tags:',
      ...merged.map((tag) => `  - ${tag}`)
    )

    return `---\n${lines.join('\n')}${rest}`
  }

  throw new Error('Unsupported tags format')
}

async function apiFetch(url: string, init: RequestInit = {}) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(url, init)

    if (response.status !== 429) return response

    const retryAfter = Number(response.headers.get('retry-after') ?? 1)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, retryAfter) * 1000)
    )
  }

  throw new Error('HedgeDoc rate limit retry exhausted')
}

export async function GET() {
  const rows = await readTrailRows()

  return NextResponse.json({
    trails: rows
      .filter((row) => row.status === 'draft')
      .map((row) => ({
        id: row.id,
        name: row.name,
        reason: row.reason ?? '',
        memberCount: Array.isArray(row.members) ? row.members.length : 0
      }))
  })
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      trailId?: string
      notes?: BatchNote[]
    }

    const notes = body.notes ?? []

    if (!body.trailId) {
      return NextResponse.json(
        { error: 'Draft user trail required' },
        { status: 400 }
      )
    }

    if (notes.length === 0) {
      return NextResponse.json(
        { error: 'No filtered notes found' },
        { status: 400 }
      )
    }

    const rows = await readTrailRows()
    const trail = rows.find(
      (row) => row.id === body.trailId && row.status === 'draft'
    )

    if (!trail) {
      return NextResponse.json(
        { error: 'Draft user trail not found' },
        { status: 404 }
      )
    }

    const env = parseEnv(await readFile(`${ROOT}/.env.memex`, 'utf8'))
    const token = env.MEMEX_API_TOKEN

    if (!token) throw new Error('MEMEX_API_TOKEN missing')

    const api =
      env.MEMEX_HEDGEDOC_API_URL?.replace(/\/$/, '') ??
      'http://127.0.0.1:3100/api/v2'

    const trailTag = `trail-${slug(trail.name)}`
    const wantedTags = ['user-trail', trailTag]

    const successes: BatchNote[] = []
    const failures: Array<{ alias: string; error: string }> = []

    for (const note of notes) {
      try {
        const alias = encodeURIComponent(note.alias)

        const getResponse = await apiFetch(
          `${api}/notes/${alias}/content`,
          {
            headers: {
              Authorization: `Bearer ${token}`
            },
            cache: 'no-store'
          }
        )

        if (!getResponse.ok) {
          throw new Error(`GET HTTP ${getResponse.status}`)
        }

        const current = await getResponse.text()
        const updated = addTags(current, wantedTags)

        if (updated !== current) {
          const putResponse = await apiFetch(
            `${api}/notes/${alias}`,
            {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'text/markdown'
              },
              body: updated
            }
          )

          if (!putResponse.ok) {
            throw new Error(`PUT HTTP ${putResponse.status}`)
          }
        }

        successes.push(note)
      } catch (error) {
        failures.push({
          alias: note.alias,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    }

    const existingMembers = Array.isArray(trail.members)
      ? trail.members
      : []

    const members = new Map<string, BatchNote>()

    for (const member of existingMembers) {
      if (member?.alias) members.set(member.alias, member)
    }

    for (const note of successes) {
      members.set(note.alias, note)
    }

    trail.members = [...members.values()]
    trail.updatedAt = new Date().toISOString()
    trail.batchTag = trailTag

    await writeFile(
      USER_TRAILS,
      rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
      'utf8'
    )

    return NextResponse.json({
      trailId: trail.id,
      trailName: trail.name,
      tag: trailTag,
      updated: successes.length,
      failed: failures.length,
      failures
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Batch user trail failed'
      },
      { status: 500 }
    )
  }
}
