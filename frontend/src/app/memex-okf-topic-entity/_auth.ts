import { readFile } from 'node:fs/promises'
import type { NextRequest } from 'next/server'

// Operator configuration stays server-side; never send API tokens to browsers.
const HEDGEDOC_PRIVATE_ME = process.env.MEMEX_OKF_PRIVATE_ME_URL ??
  'http://127.0.0.1:3100/api/private/me'
const ENV_PATHS = ['/data/projects/hedgedoc/.env', '/data/projects/hedgedoc/.env.memex']

const setting = async (name: string): Promise<string> => {
  const live = process.env[name]?.trim()
  if (live) return live
  for (const path of ENV_PATHS) {
    let data = ''
    try { data = await readFile(path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const lines = data.split(/\r?\n/)
    const row = lines.find((line) => line.trim().startsWith(`${name}=`))
    if (!row) continue
    const raw = row.slice(row.indexOf('=') + 1).trim()
    return raw.replace(/^(?:"([^"]*)"|'([^']*)')$/, (_m, a: string, b: string) => a ?? b).trim()
  }
  return ''
}

export const okfRelationsWriteEnabled = async (): Promise<boolean> =>
  (await setting('MEMEX_OKF_RELATIONS_WRITE_ENABLED')) === '1'

/** Allow the single named HedgeDoc account to run preview/apply.
 * A browser login session is required; the MEMEX_API_TOKEN is never exposed.
 * A missing operator username fails closed.
 */
export const authorizedOkfOperator = async (request: NextRequest): Promise<boolean> => {
  const operator = await setting('MEMEX_OKF_REFRESH_OPERATOR_USERNAME')
  if (!operator) return false
  const cookie = request.headers.get('cookie')
  if (!cookie) return false
  try {
    const response = await fetch(HEDGEDOC_PRIVATE_ME, {
      method: 'GET', cache: 'no-store',
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return false
    const me: unknown = await response.json()
    return !!me && typeof me === 'object' &&
      (me as Record<string, unknown>).username === operator
  } catch {
    return false
  }
}
