// lib/domain/types.ts
//
// Core types for TechnoModa's Payment Health Monitor.
// Drives ingestion shape, health classification, and anomaly detection.

// ─────────────────────────────────────────────────────────────────────────────
// Domain primitives
// ─────────────────────────────────────────────────────────────────────────────

// Countries served per brief: Peru, Brazil, Mexico, Colombia
export type Country = 'PE' | 'BR' | 'MX' | 'CO'

// Payment methods including local rails (PIX for Brazil, OXXO for Mexico)
export type PaymentMethod =
  | 'credit_card'
  | 'debit_card'
  | 'pix'         // Brazil instant payments
  | 'oxxo'        // Mexico cash voucher
  | 'bank_transfer'

// Fictional provider IDs per brief guidance
export type ProviderId =
  | 'localpay_brasil'
  | 'andes_pay'
  | 'mexico_trust'
  | 'colombia_pagos'

// Brief specifies binary outcome at authorization
export type AuthStatus = 'approved' | 'declined'

// Decline reason taxonomy from brief
export type DeclineReason =
  | 'insufficient_funds'   // most common per brief
  | 'issuer_timeout'       // soft — retryable
  | 'fraud_suspected'
  | 'card_expired'
  | 'invalid_card'
  | 'do_not_honor'         // soft — retryable
  | 'stolen_card'

// Soft (retryable) vs hard (terminal) — per brief domain background.
// Useful for Stretch C decline analysis later.
export const SOFT_DECLINES: ReadonlySet<DeclineReason> = new Set([
  'issuer_timeout',
  'do_not_honor',
])

// Health classification per brief Req 2
export type HealthStatus = 'healthy' | 'degraded' | 'critical'

// Time windows mandated by brief
export type WindowSeconds = 300 | 900 | 3600   // 5min, 15min, 60min

// ─────────────────────────────────────────────────────────────────────────────
// Transaction event (the ingestion contract)
// ─────────────────────────────────────────────────────────────────────────────

export interface Transaction {
  id: string
  providerId: ProviderId
  country: Country
  paymentMethod: PaymentMethod
  status: AuthStatus
  declineReason?: DeclineReason   // present only when status === 'declined'
  timestamp: number               // unix ms — when the auth attempt happened
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider registry
// In production this comes from config/DB; hard-coded here for the challenge.
// ─────────────────────────────────────────────────────────────────────────────

export interface Provider {
  id: ProviderId
  name: string
  country: Country
  supportedMethods: PaymentMethod[]
  // Historical baseline auth rate — in production computed from 7-30d rolling
  // history. Hard-coded for v0; documented in README as a production-deferred
  // simplification.
  baselineAuthRate: number        // 0-1
}

export const PROVIDERS: readonly Provider[] = [
  {
    id: 'localpay_brasil',
    name: 'LocalPay Brasil',
    country: 'BR',
    supportedMethods: ['credit_card', 'debit_card', 'pix'],
    baselineAuthRate: 0.75,        // brief scenario: this is the degrading one
  },
  {
    id: 'andes_pay',
    name: 'AndesPay',
    country: 'PE',
    supportedMethods: ['credit_card', 'debit_card', 'bank_transfer'],
    baselineAuthRate: 0.72,
  },
  {
    id: 'mexico_trust',
    name: 'MexicoTrust',
    country: 'MX',
    supportedMethods: ['credit_card', 'debit_card', 'oxxo'],
    baselineAuthRate: 0.70,
  },
  {
    id: 'colombia_pagos',
    name: 'ColombiaPagos',
    country: 'CO',
    supportedMethods: ['credit_card', 'debit_card', 'bank_transfer'],
    baselineAuthRate: 0.68,
  },
] as const

export function getProvider(id: ProviderId): Provider | undefined {
  return PROVIDERS.find(p => p.id === id)
}

// ─────────────────────────────────────────────────────────────────────────────
// Health classification thresholds (per brief Req 2)
// ─────────────────────────────────────────────────────────────────────────────

export const HEALTH_THRESHOLDS = {
  // Auth rate buckets evaluated against the 15min window
  healthyMin:                0.60,   // brief: ≥60% healthy
  degradedMin:               0.30,   // brief: 30-59% degraded, <30% critical

  // Low-volume trigger: fewer than N txns in 30min → critical (connectivity)
  lowVolumeWindowSeconds:    1800,
  lowVolumeThreshold:        10,

  // Anomaly: current 15min rate >20pp below provider's baseline
  anomalyDeviationThreshold: 0.20,
} as const

// ─────────────────────────────────────────────────────────────────────────────
// Computed metrics
// ─────────────────────────────────────────────────────────────────────────────

export interface WindowMetrics {
  providerId: ProviderId
  windowSeconds: WindowSeconds
  totalAttempts: number
  approvedCount: number
  declinedCount: number
  authRate: number                  // 0-1; defaults to 0 when totalAttempts === 0
}

export interface ProviderHealth {
  providerId: ProviderId
  providerName: string
  country: Country
  status: HealthStatus

  // Brief requires auth rates for all three windows in the response
  authRates: {
    '5min':  number
    '15min': number
    '60min': number
  }

  // Brief explicitly requires "total transaction volume in the last hour"
  totalVolumeLastHour: number

  // Anomaly detection per Req 3
  baselineAuthRate: number
  isAnomalous: boolean
  anomalyDelta: number              // current15min - baseline (negative = below)

  // Distinguishes the two reasons a provider can be CRITICAL
  criticalReason?: 'low_auth_rate' | 'low_volume'

  computedAt: string                // ISO 8601
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage contract — in-memory for v0, swappable for Redis/Postgres in prod
// ─────────────────────────────────────────────────────────────────────────────

export interface TransactionStore {
  ingest(txns: Transaction[]): Promise<number>     // returns count ingested
  getAll(): Promise<Transaction[]>
  getByProvider(providerId: ProviderId, sinceMs?: number): Promise<Transaction[]>
  count(): Promise<number>
  clear(): Promise<void>
}
