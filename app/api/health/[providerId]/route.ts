// app/api/health/[providerId]/route.ts
//
// GET /api/health/:providerId — health for a single provider.
//
// Returns 404 if the providerId is not in the registry.
// Otherwise returns the same ProviderHealth shape as the list endpoint.

import { NextRequest, NextResponse } from 'next/server'
import { store } from '@/lib/storage/redis'
import { getProvider } from '@/lib/domain/types'
import { computeProviderHealth } from '@/lib/domain/health'
import type { ProviderId } from '@/lib/domain/types'

export const dynamic = 'force-dynamic'

// Next.js 15+ delivers params as a Promise. Awaiting a non-promise is also
// safe in older versions, so this signature works either way.
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ providerId: string }> | { providerId: string } },
) {
  const { providerId } = await context.params

  const provider = getProvider(providerId as ProviderId)
  if (!provider) {
    return NextResponse.json(
      {
        ok: false,
        error: `Unknown provider: ${providerId}`,
        validProviders: ['localpay_brasil', 'andes_pay', 'mexico_trust', 'colombia_pagos'],
      },
      { status: 404 },
    )
  }

  try {
    // Only fetch this provider's transactions — cheaper than getAll().
    // Limit to last 1h since all our windows fit in that range.
    const oneHourAgo = Date.now() - 3600 * 1000
    const txns = await store.getByProvider(provider.id, oneHourAgo)
    const health = computeProviderHealth(txns, provider)

    return NextResponse.json({ ok: true, provider: health })
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
