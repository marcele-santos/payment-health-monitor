// app/api/decline-reasons/route.ts
//
// GET /api/decline-reasons — Stretch C
//
// Returns top-K decline reasons per provider over a configurable window.
// Helps the ops team diagnose WHY a provider is degrading.
//
// Query params:
//   ?window=<seconds>  default 3600 (1h), clamped to [60, 7200]
//   ?top=<n>           default 5, clamped to [1, 7] (we have 7 distinct reasons)

import { NextRequest, NextResponse } from 'next/server'
import { store } from '@/lib/storage/redis'
import { PROVIDERS } from '@/lib/domain/types'
import { analyzeDeclineReasons } from '@/lib/domain/decline-analysis'

export const dynamic = 'force-dynamic'

const DEFAULT_WINDOW_S = 3600
const MIN_WINDOW_S     = 60
const MAX_WINDOW_S     = 7200
const DEFAULT_TOP_K    = 5
const MAX_TOP_K        = 7

export async function GET(req: NextRequest) {
  const windowRaw = req.nextUrl.searchParams.get('window')
  const topRaw    = req.nextUrl.searchParams.get('top')

  const windowSeconds = clamp(
    windowRaw ? parseInt(windowRaw, 10) : DEFAULT_WINDOW_S,
    MIN_WINDOW_S,
    MAX_WINDOW_S,
    DEFAULT_WINDOW_S,
  )
  const topK = clamp(
    topRaw ? parseInt(topRaw, 10) : DEFAULT_TOP_K,
    1,
    MAX_TOP_K,
    DEFAULT_TOP_K,
  )

  try {
    const allTxns = await store.getAll()
    const providers = PROVIDERS.map((p) =>
      analyzeDeclineReasons(allTxns, p.id, windowSeconds, Date.now(), topK),
    )

    return NextResponse.json({
      ok: true,
      windowSeconds,
      topK,
      providers,
    })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Analysis failed',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    )
  }
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
