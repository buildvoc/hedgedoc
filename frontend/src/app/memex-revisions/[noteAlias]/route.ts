import {
  fetchMemexRevisionApi,
  memexRevisionProxyError,
} from '../_proxy'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface RouteContext {
  params: {
    noteAlias: string
  }
}

export async function GET(
  _request: Request,
  { params }: RouteContext,
): Promise<Response> {
  try {
    return await fetchMemexRevisionApi(params.noteAlias)
  } catch (error) {
    return memexRevisionProxyError(error)
  }
}
