// lib/domain/health.ts
//
// Pure functions for window metrics, health classification, and anomaly
// detection. No I/O, no storage, no clock dependency (except via optional `now`
// parameter, defaulted to Date.now()). Fully unit-testable.
//
// Spec mapping:
//   Req 1: computeWindowMetrics — auth rate per provider per rolling window
//   Req 2: classifyHealth        — healthy/degraded/critical bucketing
//   Req 3: detectAnomaly         — current vs baseline deviation
//   Assembly: computeProviderHealth — full ProviderHealth response shape

import type {
  Transaction,
  WindowMetrics,
  WindowSeconds,
  Provider,
  ProviderId,
  ProviderHealth,
  HealthStatus,
} from './types'
import { HEALTH_THRESHOLDS } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Window metrics — Req 1
// ─────────────────────────────────────────────────────────────────────────────

export function computeWindowMetrics(
  transactions: Transaction[],
  providerId: ProviderId,
  windowSeconds: WindowSeconds,
  now: number = Date.now(),
): WindowMetrics {
  const cutoff = now - windowSeconds * 1000
  const inWindow = transactions.filter(
    (t) => t.providerId === providerId && t.timestamp >= cutoff && t.timestamp <= now,
  )

  const approved = inWindow.filter((t) => t.status === 'approved').length
  const declined = inWindow.length - approved

  return {
    providerId,
    windowSeconds,
    totalAttempts: inWindow.length,
    approvedCount: approved,
    declinedCount: declined,
    // Empty window → 0 (NOT 1.0). Brief says low-volume is itself a critical
    // signal; classifyHealth handles that explicitly via the volume check.
    authRate: inWindow.length === 0 ? 0 : approved / inWindow.length,
  }
}

// Plain count helper — used for the 30min low-volume check (a non-standard
// window not in the WindowSeconds union)
export function countInWindow(
  transactions: Transaction[],
  providerId: ProviderId,
  windowSeconds: number,
  now: number = Date.now(),
): number {
  const cutoff = now - windowSeconds * 1000
  let n = 0
  for (const t of transactions) {
    if (t.providerId === providerId && t.timestamp >= cutoff && t.timestamp <= now) n++
  }
  return n
}

// ─────────────────────────────────────────────────────────────────────────────
// Health classification — Req 2
// ─────────────────────────────────────────────────────────────────────────────

export interface ClassificationResult {
  status: HealthStatus
  criticalReason?: 'low_auth_rate' | 'low_volume'
}

export function classifyHealth(
  authRate15min: number,
  volume30min: number,
): ClassificationResult {
  // Low-volume rule fires FIRST — connectivity dead is more urgent than
  // any auth-rate reading (which would be unreliable on tiny samples anyway).
  if (volume30min < HEALTH_THRESHOLDS.lowVolumeThreshold) {
    return { status: 'critical', criticalReason: 'low_volume' }
  }

  if (authRate15min < HEALTH_THRESHOLDS.degradedMin) {
    return { status: 'critical', criticalReason: 'low_auth_rate' }
  }

  if (authRate15min < HEALTH_THRESHOLDS.healthyMin) {
    return { status: 'degraded' }
  }

  return { status: 'healthy' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Anomaly detection — Req 3
// ─────────────────────────────────────────────────────────────────────────────

export interface AnomalyResult {
  isAnomalous: boolean
  anomalyDelta: number // current - baseline; negative = below baseline
}

export function detectAnomaly(
  currentAuthRate: number,
  baselineAuthRate: number,
): AnomalyResult {
  const delta = currentAuthRate - baselineAuthRate
  return {
    isAnomalous: delta < -HEALTH_THRESHOLDS.anomalyDeviationThreshold,
    anomalyDelta: delta,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Full ProviderHealth assembly — what /api/health returns per provider
// ─────────────────────────────────────────────────────────────────────────────

export function computeProviderHealth(
  transactions: Transaction[],
  provider: Provider,
  now: number = Date.now(),
): ProviderHealth {
  const w5  = computeWindowMetrics(transactions, provider.id, 300,  now)
  const w15 = computeWindowMetrics(transactions, provider.id, 900,  now)
  const w60 = computeWindowMetrics(transactions, provider.id, 3600, now)
  const volume30min = countInWindow(transactions, provider.id, 1800, now)

  const classification = classifyHealth(w15.authRate, volume30min)
  const anomaly        = detectAnomaly(w15.authRate, provider.baselineAuthRate)

  return {
    providerId:   provider.id,
    providerName: provider.name,
    country:      provider.country,
    status:       classification.status,
    authRates: {
      '5min':  round4(w5.authRate),
      '15min': round4(w15.authRate),
      '60min': round4(w60.authRate),
    },
    totalVolumeLastHour: w60.totalAttempts,
    baselineAuthRate:    provider.baselineAuthRate,
    isAnomalous:         anomaly.isAnomalous,
    anomalyDelta:        round4(anomaly.anomalyDelta),
    criticalReason:      classification.criticalReason,
    computedAt:          new Date(now).toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}
