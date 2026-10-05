import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type MemexKvCacheType = 'f16' | 'q8_0' | 'q4_0'
export type MemexProvider = 'ollama' | 'llamacpp'

export interface MemexModelSettings {
  provider: MemexProvider
  baseUrl: string
  defaultModel: string
  numCtx: number
  maxPromptChars: number
  timeoutSeconds: number
  temperature: number
  ollamaFlashAttention: boolean
  ollamaKvCacheType: MemexKvCacheType
}

export const SETTINGS_PATH =
  process.env.MEMEX_MODEL_SETTINGS_PATH ??
  '/data/projects/hedgedoc/memex/model-settings.json'

export const DEFAULT_MEMEX_MODEL_SETTINGS: MemexModelSettings = {
  provider: 'llamacpp',
  baseUrl: 'http://192.168.1.99:8080/v1',
  defaultModel: '/data/projects/llama.cpp/models/gemma4-26b-standalone.gguf',
  numCtx: 65536,
  maxPromptChars: 80000,
  timeoutSeconds: 600,
  temperature: 0.35,
  ollamaFlashAttention: true,
  ollamaKvCacheType: 'q8_0',
}

const modelPattern = /^[A-Za-z0-9_.:/@+\-]+$/

const integerInRange = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    return fallback
  }
  return number
}

const numberInRange = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    return fallback
  }
  return number
}

const normalizeProvider = (
  value: unknown,
  fallback: MemexProvider,
): MemexProvider =>
  value === 'ollama' || value === 'llamacpp' ? value : fallback

const normalizeBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const normalizeKvCacheType = (
  value: unknown,
  fallback: MemexKvCacheType,
): MemexKvCacheType =>
  value === 'f16' || value === 'q8_0' || value === 'q4_0'
    ? value
    : fallback

const normalizeModel = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback
  const model = value.trim()
  if (!model || model.length > 160 || !modelPattern.test(model)) return fallback
  return model
}

const normalizeBaseUrl = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback
  const input = value.trim().replace(/\/+$/, '')

  try {
    const url = new URL(input)
    if (!['http:', 'https:'].includes(url.protocol)) return fallback
    if (url.username || url.password) return fallback
    return url.toString().replace(/\/$/, '')
  } catch {
    return fallback
  }
}

export const normalizeMemexModelSettings = (
  value: unknown,
): MemexModelSettings => {
  const row =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {}

  const defaults = DEFAULT_MEMEX_MODEL_SETTINGS
  const provider = normalizeProvider(row.provider, defaults.provider)
  const ollamaFlashAttention = normalizeBoolean(
    row.ollamaFlashAttention,
    defaults.ollamaFlashAttention,
  )
  const requestedKvCacheType = normalizeKvCacheType(
    row.ollamaKvCacheType,
    defaults.ollamaKvCacheType,
  )

  return {
    provider,
    baseUrl: normalizeBaseUrl(row.baseUrl, defaults.baseUrl),
    defaultModel: normalizeModel(row.defaultModel, defaults.defaultModel),
    numCtx: integerInRange(row.numCtx, defaults.numCtx, 1024, 1048576),
    maxPromptChars: integerInRange(
      row.maxPromptChars,
      defaults.maxPromptChars,
      1000,
      2000000,
    ),
    timeoutSeconds: integerInRange(
      row.timeoutSeconds,
      defaults.timeoutSeconds,
      10,
      3600,
    ),
    temperature: numberInRange(row.temperature, defaults.temperature, 0, 2),
    ollamaFlashAttention,
    ollamaKvCacheType: ollamaFlashAttention ? requestedKvCacheType : 'f16',
  }
}

export const readMemexModelSettings = async (): Promise<MemexModelSettings> => {
  try {
    const text = await readFile(SETTINGS_PATH, 'utf8')
    return normalizeMemexModelSettings(JSON.parse(text))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_MEMEX_MODEL_SETTINGS
    }
    throw error
  }
}

export const writeMemexModelSettings = async (
  settings: MemexModelSettings,
): Promise<void> => {
  const normalized = normalizeMemexModelSettings(settings)
  const tempPath = `${SETTINGS_PATH}.tmp-${process.pid}-${Date.now()}`

  await mkdir(dirname(SETTINGS_PATH), { recursive: true })
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  await rename(tempPath, SETTINGS_PATH)
}
