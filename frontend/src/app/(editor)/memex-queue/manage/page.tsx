import { readFile } from 'node:fs/promises'

import {
  MemexQueueManager,
  type QueueManagerSource
} from './memex-queue-manager'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const MEMEX_INDEX_PATH =
  process.env.MEMEX_INDEX_PATH ?? '/data/projects/hedgedoc/memex/index.md'
const MODEL_SETTINGS_PATH =
  process.env.MEMEX_MODEL_SETTINGS_PATH ??
  '/data/projects/hedgedoc/memex/model-settings.json'


interface QueueManagerModelSettings {
  provider?: string
  baseUrl?: string
  defaultModel?: string
}

const sourcePattern =
  /^- \[([^\]]+)\]\([^)]*\/(?:n|p|s)\/([^?#)]+)[^)]*\)(?: — (.*))?$/gm

const parseSources = (content: string): QueueManagerSource[] => {
  const section = content.split('## Sources', 2)[1]?.split('## Trails', 1)[0] ?? ''
  const result: QueueManagerSource[] = []
  const seen = new Set<string>()
  sourcePattern.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = sourcePattern.exec(section)) !== null) {
    const alias = decodeURIComponent(match[2])
    if (!alias || seen.has(alias)) continue
    seen.add(alias)
    result.push({
      alias,
      title: match[1].trim(),
      summary: (match[3] ?? '').trim()
    })
  }

  return result
}

export default async function MemexQueueManagePage() {
  let sources: QueueManagerSource[] = []
  let sourceError = ''
  let modelSettings: QueueManagerModelSettings = {}

  try {
    sources = parseSources(await readFile(MEMEX_INDEX_PATH, 'utf8'))
  } catch (error) {
    sourceError =
      error instanceof Error ? error.message : 'Unable to read Memex index'
  }

  try {
    const parsed = JSON.parse(
      await readFile(MODEL_SETTINGS_PATH, 'utf8')
    ) as QueueManagerModelSettings
    if (parsed && typeof parsed === 'object') {
      modelSettings = parsed
    }
  } catch {
    // Model settings are status-only on this page. The settings page remains
    // authoritative and can still be opened if this read is unavailable.
  }

  return (
    <MemexQueueManager
      initialSources={sources}
      sourceError={sourceError}
      modelSettings={modelSettings}
    />
  )
}
