import { NextResponse } from 'next/server'
import {
  normalizeMemexModelSettings,
  readMemexModelSettings,
  writeMemexModelSettings,
} from './_settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return NextResponse.json(await readMemexModelSettings(), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to read Memex model settings',
      },
      { status: 500 },
    )
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json()
    const settings = normalizeMemexModelSettings(body)
    await writeMemexModelSettings(settings)

    return NextResponse.json(settings, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to save Memex model settings',
      },
      { status: 500 },
    )
  }
}
