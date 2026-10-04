import { readFile, writeFile } from 'node:fs/promises'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROOT = '/data/projects/hedgedoc'
const INDEX = `${ROOT}/memex/index.md`
const QUEUE = `${ROOT}/memex/queue.jsonl`
const USER_TRAILS = `${ROOT}/memex/user_trails.jsonl`

interface Member {
  alias: string
  title: string
}

interface Trail {
  id: string
  recordId?: string
  name: string
  reason: string
  origin: 'system' | 'user'
  status?: 'draft' | 'integrated'
  members: Member[]
}

function links(text: string): Member[] {
  const result: Member[] = []
  const seen = new Set<string>()
  const rx = /\[([^\]]+)\]\([^)]*\/n\/([^?#)]+)[^)]*\)/g
  let match: RegExpExecArray | null

  while ((match = rx.exec(text)) !== null) {
    const alias = decodeURIComponent(match[2])
    if (!seen.has(alias)) {
      seen.add(alias)
      result.push({ title: match[1], alias })
    }
  }

  return result
}

function parseSystemTrails(index: string): Trail[] {
  const section = index.split('## Trails', 2)[1] ?? ''
  const trails: Trail[] = []
  const headings = [...section.matchAll(/^###\s+(.+)$/gm)]

  headings.forEach((heading, i) => {
    const start = (heading.index ?? 0) + heading[0].length
    const end = headings[i + 1]?.index ?? section.length
    const block = section.slice(start, end)
    const members = links(block)

    if (members.length >= 2) {
      const reason =
        block
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line && !line.startsWith('-')) ?? ''

      trails.push({
        id: `system-${i}`,
        name: heading[1].trim(),
        reason,
        origin: 'system',
        members
      })
    }
  })

  return trails
}

async function readUserRows() {
  try {
    return (await readFile(USER_TRAILS, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function currentSourceAliases(index: string): Set<string> {
  const sourceSection =
    index.split('## Sources', 2)[1]?.split('## Trails', 1)[0] ?? ''

  return new Set(links(sourceSection).map((member) => member.alias))
}

function currentMembers(members: unknown, activeAliases: Set<string>): Member[] {
  if (!Array.isArray(members)) return []

  return members.filter(
    (member): member is Member =>
      Boolean(
        member &&
          typeof member === 'object' &&
          typeof member.alias === 'string' &&
          typeof member.title === 'string' &&
          activeAliases.has(member.alias)
      )
  )
}

async function parseUserTrails(activeAliases: Set<string>): Promise<Trail[]> {
  const rows = await readUserRows()

  return rows
    .filter(
      (row) =>
        row.id &&
        row.name &&
        ['draft', 'committed', 'integrated'].includes(row.status)
    )
    .map((row): Trail => ({
      id: `user-${row.id}`,
      recordId: row.id,
      name: row.name,
      reason: row.reason ?? '',
      origin: 'user' as const,
      status: row.status === 'integrated' ? 'integrated' : 'draft',
      members: currentMembers(row.members, activeAliases)
    }))
    .filter((trail) => trail.members.length >= 2)
}

function parseEnv(text: string) {
  const env: Record<string, string> = {}

  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (match) {
      env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
    }
  }

  return env
}

function clean(value: string) {
  return value.replace(/[;\r\n]+/g, ' ').trim()
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function mergeIntoNodeBook(content: string, trails: any[]) {
  const match = content.match(/```nodeBook\n([\s\S]*?)\n```/)

  if (!match) throw new Error('nodeBook graph block not found')

  let graph = match[1]

  const graphAliases = new Set(
    [...graph.matchAll(/^alias:\s*(.+?);$/gm)].map((item) => item[1])
  )

  const missing = trails.flatMap((trail) =>
    trail.members
      .filter((member: Member) => !graphAliases.has(member.alias))
      .map((member: Member) => member.alias)
  )

  if (missing.length > 0) {
    throw new Error(`Sources missing from nodeBook: ${[...new Set(missing)].join(', ')}`)
  }

  const memberships = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()

  for (const trail of trails) {
    const name = clean(trail.name)
    const relation = `user_${slug(name) || 'trail'}`

    for (const member of trail.members) {
      const existing = memberships.get(member.alias) ?? []
      existing.push(name)
      memberships.set(member.alias, existing)
    }

    for (let i = 0; i < trail.members.length - 1; i++) {
      const source = trail.members[i]
      const target = trail.members[i + 1]
      const lines = outgoing.get(source.alias) ?? []

      lines.push(
        `<${relation}> ${clean(target.title)} · ${clean(target.alias)};`
      )
      outgoing.set(source.alias, lines)
    }
  }

  const blocks = graph.split(/(?=^# )/m)

  graph = blocks
    .map((block) => {
      const alias = block.match(/^alias:\s*(.+?);$/m)?.[1]
      if (!alias) return block

      const additions: string[] = []

      for (const name of memberships.get(alias) ?? []) {
        const line = `trail: ${name};`
        if (!block.includes(line)) additions.push(line)
      }

      for (const line of outgoing.get(alias) ?? []) {
        if (!block.includes(line)) additions.push(line)
      }

      if (additions.length === 0) return block

      const lines = block.trimEnd().split('\n')
      const aliasIndex = lines.findIndex((line) => line.startsWith('alias:'))
      lines.splice(aliasIndex + 1, 0, ...additions)

      return `${lines.join('\n')}\n\n`
    })
    .join('')

  content = content.replace(match[0], `\`\`\`nodeBook\n${graph.trimEnd()}\n\`\`\``)

  const newBlocks = trails
    .filter((trail) => !content.includes(`<!-- user-trail:${trail.id} -->`))
    .map(
      (trail) => `<!-- user-trail:${trail.id} -->
### User Trail: ${clean(trail.name)}

${trail.reason ?? ''}

Status: \`integrated\`

${trail.members.map((member: Member) => `- ${member.title}`).join('\n')}
`
    )

  if (newBlocks.length > 0) {
    const graphHeading = '\n## Graph\n'

    if (content.includes('\n## User Trails\n')) {
      content = content.replace(
        graphHeading,
        `\n${newBlocks.join('\n')}${graphHeading}`
      )
    } else {
      content = content.replace(
        graphHeading,
        `\n## User Trails\n\n${newBlocks.join('\n')}${graphHeading}`
      )
    }
  }

  return content
}

export async function GET(request: NextRequest) {
  const index = await readFile(INDEX, 'utf8')
  const activeAliases = currentSourceAliases(index)
  const includeDrafts =
    request.nextUrl.searchParams.get('includeDrafts') === '1'
  const userTrails = (await parseUserTrails(activeAliases)).filter(
    (trail) => includeDrafts || trail.status === 'integrated'
  )
  const trails = [
    ...parseSystemTrails(index),
    ...userTrails
  ]

  return NextResponse.json({
    trails,
    systemCount: trails.filter((trail) => trail.origin === 'system').length,
    userCount: trails.filter((trail) => trail.origin === 'user').length
  })
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      action?: string
      ids?: string[]
    }

    if (body.action !== 'integrate' || !body.ids?.length) {
      return NextResponse.json({ error: 'No user trails selected' }, { status: 400 })
    }

    const rows = await readUserRows()
    const index = await readFile(INDEX, 'utf8')
    const activeAliases = currentSourceAliases(index)
    const selected = rows
      .filter(
        (row) =>
          body.ids?.includes(row.id) &&
          ['draft', 'committed'].includes(row.status)
      )
      .map((row) => ({
        ...row,
        members: currentMembers(row.members, activeAliases)
      }))
      .filter((row) => row.members.length >= 2)

    if (selected.length === 0) {
      return NextResponse.json(
        { error: 'No selected draft trail has at least two current indexed sources' },
        { status: 400 }
      )
    }

    const env = parseEnv(await readFile(`${ROOT}/.env.memex`, 'utf8'))
    const token = env.MEMEX_API_TOKEN

    if (!token) throw new Error('MEMEX_API_TOKEN missing')

    const queueRows = (await readFile(QUEUE, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    const nodeBook =
      [...queueRows].reverse().find((row) => row.nodeBook)?.nodeBook ??
      env.MEMEX_NODEBOOK_ALIAS

    if (!nodeBook) throw new Error('Current nodeBook alias not found')

    const api =
      env.MEMEX_HEDGEDOC_API_URL?.replace(/\/$/, '') ??
      'http://127.0.0.1:3100/api/v2'

    const headers = {
      Authorization: `Bearer ${token}`
    }

    const currentResponse = await fetch(
      `${api}/notes/${encodeURIComponent(nodeBook)}/content`,
      { headers, cache: 'no-store' }
    )

    if (!currentResponse.ok) {
      throw new Error(`nodeBook GET HTTP ${currentResponse.status}`)
    }

    const current = await currentResponse.text()
    const updated = mergeIntoNodeBook(current, selected)

    const putResponse = await fetch(
      `${api}/notes/${encodeURIComponent(nodeBook)}`,
      {
        method: 'PUT',
        headers: {
          ...headers,
          'Content-Type': 'text/markdown'
        },
        body: updated
      }
    )

    if (!putResponse.ok) {
      throw new Error(`nodeBook PUT HTTP ${putResponse.status}`)
    }

    const now = new Date().toISOString()

    for (const row of rows) {
      if (body.ids.includes(row.id) && ['draft', 'committed'].includes(row.status)) {
        row.status = 'integrated'
        row.nodeBookStatus = 'integrated'
        row.integratedAt = now
        row.nodeBook = nodeBook
      }
    }

    await writeFile(
      USER_TRAILS,
      rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
      'utf8'
    )

    return NextResponse.json({
      integrated: selected.length,
      nodeBook
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Integration failed' },
      { status: 500 }
    )
  }
}
