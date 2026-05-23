// lib/domain/decline-analysis.ts
//
// Pure aggregation: top decline reasons per provider over a time window.
// Stretch C: helps diagnose WHY a provider is degrading. A burst of
// issuer_timeout is a different problem than a burst of insufficient_funds.

import type {
  Transaction,
  ProviderId,
  DeclineReason,
} from './types'

export interface DeclineReasonCount {
  reason:     DeclineReason
  count:      number
  percentage: number  // share of THIS provider's declines, not all txns
}

export interface ProviderDeclineAnalysis {
  providerId:    ProviderId
  windowSeconds: number
  totalAttempts: number
  totalDeclined: number
  declineRate:   number    // declined / attempts
  topReasons:    DeclineReasonCount[]
}

export function analyzeDeclineReasons(
  transactions: Transaction[],
  providerId: ProviderId,
  windowSeconds: number = 3600,
  now: number = Date.now(),
  topK: number = 5,
): ProviderDeclineAnalysis {
  const cutoff = now - windowSeconds * 1000
  const inWindow = transactions.filter(
    (t) => t.providerId === providerId && t.timestamp >= cutoff && t.timestamp <= now,
  )

  const declined = inWindow.filter((t) => t.status === 'declined')

  const counts = new Map<DeclineReason, number>()
  for (const t of declined) {
    if (!t.declineReason) continue   // schema invariant guarantees this
    counts.set(t.declineReason, (counts.get(t.declineReason) ?? 0) + 1)
  }

  const total = declined.length
  const topReasons: DeclineReasonCount[] = [...counts.entries()]
    .map(([reason, count]) => ({
      reason,
      count,
      percentage: total > 0 ? Math.round((count / total) * 10_000) / 10_000 : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topK)

  return {
    providerId,
    windowSeconds,
    totalAttempts: inWindow.length,
    totalDeclined: total,
    declineRate: inWindow.length > 0 ? Math.round((total / inWindow.length) * 10_000) / 10_000 : 0,
    topReasons,
  }
}
