// app/api/health/route.ts
//
// GET /api/health — returns health status for ALL providers + summary.
//
// Brief Req 2: "returns current health status for all providers or a specific
// provider". This route handles the "all" case; /api/health/[providerId]
// handles the per-provider case.
//
// Polling pattern: brief says "fast enough to query every 10 seconds".
// We disable Next.js route caching (force-dynamic) to ensure each poll
// reads fresh data from Redis.

import { NextResponse } from 'next/server'
import { store } from '@/lib/storage/redis'
import { PROVIDERS } from '@/lib/domain/types'
import { computeProviderHealth } from '@/lib/domain/health'

export const dynamic = 'force-dynamic'

export async function GET() {
  const now = Date.now()

  try {
    const allTxns = await store.getAll()
    const providers = PROVIDERS.map((p) => computeProviderHealth(allTxns, p, now))

    const summary = {
      total:    providers.length,
      healthy:  providers.filter((h) => h.status === 'healthy').length,
      degraded: providers.filter((h) => h.status === 'degraded').length,
      critical: providers.filter((h) => h.status === 'critical').length,
      anomalousCount: providers.filter((h) => h.isAnomalous).length,
    }

    // Overall system status — worst-of-all
    const overallStatus =
      summary.critical > 0 ? 'critical'
      : summary.degraded > 0 ? 'degraded'
      : 'healthy'

    return NextResponse.json({
      ok:        true,
      computedAt: new Date(now).toISOString(),
      overallStatus,
      summary,
      providers,
    })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Health query failed',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    )
  }
}
