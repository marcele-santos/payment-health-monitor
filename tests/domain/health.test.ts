// tests/domain/health.test.ts
//
// Table-driven unit tests for the health module.
// Covers the three measurable spec requirements:
//   - auth rate calculation across rolling windows
//   - health status classification (including low-volume rule)
//   - anomaly detection vs baseline

import { describe, it, expect } from 'vitest'
import {
  computeWindowMetrics,
  countInWindow,
  classifyHealth,
  detectAnomaly,
  computeProviderHealth,
} from '../../lib/domain/health'
import { PROVIDERS, getProvider } from '../../lib/domain/types'
import type { Transaction, ProviderId } from '../../lib/domain/types'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const NOW = 1_716_480_000_000 // fixed reference instant

function makeTxn(
  i: number,
  providerId: ProviderId,
  status: 'approved' | 'declined',
  secondsAgo: number,
): Transaction {
  return {
    id:            `t${i}`,
    providerId,
    country:       'BR',
    paymentMethod: 'credit_card',
    status,
    declineReason: status === 'declined' ? 'insufficient_funds' : undefined,
    timestamp:     NOW - secondsAgo * 1000,
  }
}

// Build a list with `approved` approvals and `declined` declines, all within
// the past `windowSeconds` seconds (evenly distributed).
function makeMix(
  providerId: ProviderId,
  approved: number,
  declined: number,
  windowSeconds: number,
): Transaction[] {
  const total = approved + declined
  const step = total > 0 ? Math.floor((windowSeconds - 1) / total) : 0
  const txns: Transaction[] = []
  for (let i = 0; i < approved; i++)
    txns.push(makeTxn(i, providerId, 'approved', i * step))
  for (let i = 0; i < declined; i++)
    txns.push(makeTxn(approved + i, providerId, 'declined', (approved + i) * step))
  return txns
}

// ─────────────────────────────────────────────────────────────────────────────
// computeWindowMetrics
// ─────────────────────────────────────────────────────────────────────────────

describe('computeWindowMetrics — Req 1', () => {
  it('computes auth rate for a healthy provider (75% approved)', () => {
    const txns = makeMix('localpay_brasil', 75, 25, 300)
    const m = computeWindowMetrics(txns, 'localpay_brasil', 300, NOW)
    expect(m.totalAttempts).toBe(100)
    expect(m.approvedCount).toBe(75)
    expect(m.declinedCount).toBe(25)
    expect(m.authRate).toBeCloseTo(0.75, 4)
  })

  it('computes 0 auth rate when no transactions in window', () => {
    const m = computeWindowMetrics([], 'localpay_brasil', 300, NOW)
    expect(m.totalAttempts).toBe(0)
    expect(m.authRate).toBe(0)
  })

  it('excludes transactions outside the time window', () => {
    const txns = [
      makeTxn(1, 'localpay_brasil', 'approved', 30),   // inside 60s
      makeTxn(2, 'localpay_brasil', 'approved', 90),   // outside 60s
      makeTxn(3, 'localpay_brasil', 'declined', 120),  // outside 60s
    ]
    const m = computeWindowMetrics(txns, 'localpay_brasil', 60, NOW)
    expect(m.totalAttempts).toBe(1)
    expect(m.authRate).toBe(1)
  })

  it('excludes transactions from other providers', () => {
    const txns = [
      makeTxn(1, 'localpay_brasil', 'approved', 30),
      makeTxn(2, 'andes_pay',       'approved', 30),
      makeTxn(3, 'andes_pay',       'approved', 30),
    ]
    const m = computeWindowMetrics(txns, 'localpay_brasil', 300, NOW)
    expect(m.totalAttempts).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// classifyHealth
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyHealth — Req 2', () => {
  const cases = [
    // [name, authRate15, volume30, expectedStatus, expectedCriticalReason]
    ['healthy: 75% auth, 100 txns',         0.75, 100, 'healthy',  undefined],
    ['boundary healthy: 60% auth',           0.60, 100, 'healthy',  undefined],
    ['degraded: 45% auth',                   0.45, 100, 'degraded', undefined],
    ['boundary degraded: 30% auth',          0.30, 100, 'degraded', undefined],
    ['critical low_auth_rate: 15%',          0.15, 100, 'critical', 'low_auth_rate'],
    ['critical low_volume: <10 in 30min',    0.80,   5, 'critical', 'low_volume'],
    ['low_volume beats good auth rate',      1.00,   3, 'critical', 'low_volume'],
    ['low_volume boundary: 10 txns is ok',   0.80,  10, 'healthy',  undefined],
  ] as const

  cases.forEach(([name, authRate, vol, expectedStatus, expectedReason]) => {
    it(name, () => {
      const result = classifyHealth(authRate, vol)
      expect(result.status).toBe(expectedStatus)
      expect(result.criticalReason).toBe(expectedReason)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// detectAnomaly
// ─────────────────────────────────────────────────────────────────────────────

describe('detectAnomaly — Req 3', () => {
  it('flags anomaly when current is >20pp below baseline', () => {
    const r = detectAnomaly(0.45, 0.75) // delta = -0.30
    expect(r.isAnomalous).toBe(true)
    expect(r.anomalyDelta).toBeCloseTo(-0.30, 4)
  })

  it('does not flag at exactly the 20pp threshold', () => {
    const r = detectAnomaly(0.55, 0.75) // delta = -0.20
    expect(r.isAnomalous).toBe(false)
  })

  it('does not flag when current is above baseline', () => {
    const r = detectAnomaly(0.85, 0.75)
    expect(r.isAnomalous).toBe(false)
    expect(r.anomalyDelta).toBeCloseTo(0.10, 4)
  })

  it('flags the LocalPay Brasil collapse scenario', () => {
    // Brief: baseline 78%, drops to 11% during incident
    const r = detectAnomaly(0.11, 0.78)
    expect(r.isAnomalous).toBe(true)
    expect(r.anomalyDelta).toBeCloseTo(-0.67, 4)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// computeProviderHealth — integration of the pieces
// ─────────────────────────────────────────────────────────────────────────────

describe('computeProviderHealth — assembly', () => {
  it('healthy provider with normal traffic', () => {
    const psp = getProvider('andes_pay')!
    const txns = makeMix('andes_pay', 72, 28, 900) // 72% in 15min window
    const h = computeProviderHealth(txns, psp, NOW)

    expect(h.providerId).toBe('andes_pay')
    expect(h.status).toBe('healthy')
    expect(h.authRates['15min']).toBeCloseTo(0.72, 4)
    expect(h.isAnomalous).toBe(false)
    expect(h.criticalReason).toBeUndefined()
  })

  it('LocalPay Brasil collapse — critical + anomalous', () => {
    const psp = getProvider('localpay_brasil')!  // baseline 0.75
    // ~15% auth rate during collapse
    const txns = makeMix('localpay_brasil', 15, 85, 900)
    const h = computeProviderHealth(txns, psp, NOW)

    expect(h.status).toBe('critical')
    expect(h.criticalReason).toBe('low_auth_rate')
    expect(h.authRates['15min']).toBeCloseTo(0.15, 4)
    expect(h.isAnomalous).toBe(true)
    expect(h.anomalyDelta).toBeLessThan(-0.20)
  })

  it('low-volume edge case — critical with low_volume reason', () => {
    const psp = getProvider('colombia_pagos')!
    // Only 4 transactions in last 30min — below threshold of 10
    const txns = makeMix('colombia_pagos', 4, 0, 600)
    const h = computeProviderHealth(txns, psp, NOW)

    expect(h.status).toBe('critical')
    expect(h.criticalReason).toBe('low_volume')
  })

  it('returns the brief-required response shape', () => {
    const psp = getProvider('mexico_trust')!
    const h = computeProviderHealth(makeMix('mexico_trust', 70, 30, 900), psp, NOW)

    // Brief: response includes provider ID, auth rate per window, volume, status
    expect(h).toHaveProperty('providerId')
    expect(h).toHaveProperty('providerName')
    expect(h).toHaveProperty('country')
    expect(h).toHaveProperty('status')
    expect(h.authRates).toHaveProperty('5min')
    expect(h.authRates).toHaveProperty('15min')
    expect(h.authRates).toHaveProperty('60min')
    expect(h).toHaveProperty('totalVolumeLastHour')
    expect(h).toHaveProperty('baselineAuthRate')
    expect(h).toHaveProperty('isAnomalous')
    expect(h).toHaveProperty('anomalyDelta')
    expect(h).toHaveProperty('computedAt')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// countInWindow
// ─────────────────────────────────────────────────────────────────────────────

describe('countInWindow', () => {
  it('counts only matching provider within window', () => {
    const txns = [
      makeTxn(1, 'localpay_brasil', 'approved', 100),
      makeTxn(2, 'localpay_brasil', 'declined', 200),
      makeTxn(3, 'localpay_brasil', 'approved', 2000), // outside 30min (1800s)
      makeTxn(4, 'andes_pay',       'approved', 100),  // wrong provider
    ]
    expect(countInWindow(txns, 'localpay_brasil', 1800, NOW)).toBe(2)
  })
})
