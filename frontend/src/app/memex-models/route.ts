import { NextResponse } from 'next/server'
import {
  normalizeMemexModelSettings,
  readMemexModelSettings,
  type MemexModelSettings,
} from '../memex-model-settings/_settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface OllamaModel {
  name?: string
  model?: string
}

interface LlamaCppModel {
  id?: string
}

async function discoverModels(settings: MemexModelSettings) {
  const endpoint =
    settings.provider === 'ollama'
      ? `${settings.baseUrl}/api/tags`
      : `${settings.baseUrl}/models`

  const response = await fetch(endpoint, {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  })

  if (!response.ok) {
    throw new Error(
      `${settings.provider === 'ollama' ? 'Ollama' : 'llama.cpp'} returned HTTP ${response.status}`,
    )
  }

  let models: string[] = []

  if (settings.provider === 'ollama') {
    const payload = (await response.json()) as { models?: OllamaModel[] }
    models = Array.from(
      new Set(
        (payload.models ?? [])
          .map((item) => (item.name ?? item.model ?? '').trim())
          .filter(Boolean),
      ),
    ).sort()
  } else {
    const payload = (await response.json()) as { data?: LlamaCppModel[] }
    models = Array.from(
      new Set(
        (payload.data ?? [])
          .map((item) => (item.id ?? '').trim())
          .filter(Boolean),
      ),
    ).sort()
  }

  if (!models.includes(settings.defaultModel)) {
    models.unshift(settings.defaultModel)
  }

  return {
    connected: true,
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    defaultModel: settings.defaultModel,
    models,
  }
}

export async function GET() {
  try {
    return NextResponse.json(await discoverModels(await readMemexModelSettings()), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    const settings = await readMemexModelSettings().catch(() => null)

    return NextResponse.json(
      {
        connected: false,
        provider: settings?.provider,
        baseUrl: settings?.baseUrl,
        defaultModel: settings?.defaultModel,
        models: settings?.defaultModel ? [settings.defaultModel] : [],
        error: error instanceof Error ? error.message : 'Unable to query models',
      },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      },
    )
  }
}

export async function POST(request: Request) {
  try {
    const settings = normalizeMemexModelSettings(await request.json())
    return NextResponse.json(await discoverModels(settings), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return NextResponse.json(
      {
        connected: false,
        models: [],
        error: error instanceof Error ? error.message : 'Unable to query models',
      },
      { status: 503 },
    )
  }
}
