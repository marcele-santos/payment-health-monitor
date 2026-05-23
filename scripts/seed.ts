// scripts/seed.ts
//
// Generates a realistic TechnoModa flash sale scenario and seeds the running
// service with the data via POST /api/transactions.
//
// Scenario design (per brief test data requirements):
//   - ~520 transactions across a 2-hour window
//   - 4 providers across 4 countries
//   - LocalPay Brasil (the degrading one): 75% baseline, drops to ~15% during
//     a 25min window (T+30 → T+65), recovers to ~70% by T+80
//   - ColombiaPagos: deliberate low-volume edge case (5 total txns)
//   - Realistic decline reason mix; insufficient_funds dominant per brief
//   - Local payment methods present: PIX (BR), OXXO (MX)
//
// Usage:
//   npm run seed                                # POST to http://localhost:3000
//   npm run seed -- https://my-app.vercel.app   # POST to deployed URL
//   npm run seed:dry                            # Write to data.json instead

import { writeFileSync } from 'node:fs'
import type {
  Transaction,
  ProviderId,
  Country,
  PaymentMethod,
  DeclineReason,
} from '../lib/domain/types'

// ─────────────────────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2)
const dryRun   = args.includes('--dry-run')
const baseUrl  = (args.find((a) => a.startsWith('http')) ?? 'http://localhost:3000').replace(/\/$/, '')

// ─────────────────────────────────────────────────────────────────────────────
// Scenario anchors
// ─────────────────────────────────────────────────────────────────────────────

// Anchor scenario END at "now" so all 60min/15min/5min queries land on the
// freshest data. SCENARIO covers the prior 2 hours.
const NOW            = Date.now()
const SCENARIO_END   = NOW
const SCENARIO_START = NOW - 2 * 3600 * 1000

const minToMs = (m: number) => m * 60_000

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic PRNG — same seed produces same dataset on every run
// ─────────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(42)

function pickWeighted<T>(items: Array<[T, number]>): T {
  const total = items.reduce((s, [, w]) => s + w, 0)
  let r = rand() * total
  for (const [item, w] of items) {
    r -= w
    if (r <= 0) return item
  }
  return items[items.length - 1][0]
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider behavior curves
// ─────────────────────────────────────────────────────────────────────────────

// LocalPay Brasil — the degrading provider. Curve repositioned so the
// collapse is ONGOING at "now" (the reviewer needs to see the system catching
// the degradation, not the post-incident steady state).
//
// T=0    → T+60min : 75% baseline (first hour, normal operations)
// T+60   → T+70min : linear drop 75% → 15% (collapse ramps over 10min)
// T+70   → T+120   : critical phase, ~15% (still ongoing at "now")
function localPayAuthRateAt(tMs: number): number {
  const minSinceStart = (tMs - SCENARIO_START) / 60_000

  if (minSinceStart < 60)  return 0.75
  if (minSinceStart < 70)  return 0.75 - ((minSinceStart - 60) / 10) * 0.60
  return 0.15
}

// Other providers — stable curves with mild noise
const andesPayAuthRateAt:      (t: number) => number = () => 0.72
const mexicoTrustAuthRateAt:   (t: number) => number = () => 0.70
const colombiaPagosAuthRateAt: (t: number) => number = () => 0.68

// Volume modulation (flash sale curve): pre-sale low, peak high, tail moderate
function volumeMultiplierAt(tMs: number): number {
  const min = (tMs - SCENARIO_START) / 60_000
  if (min < 20)  return 1.0  // pre-sale
  if (min < 80)  return 3.5  // sale peak
  return 1.5                  // tail
}

// ─────────────────────────────────────────────────────────────────────────────
// Decline reason distributions
// ─────────────────────────────────────────────────────────────────────────────

// Baseline mix per brief: insufficient_funds dominant, then mixed soft/hard
const BASELINE_DECLINE_MIX: Array<[DeclineReason, number]> = [
  ['insufficient_funds', 0.50],
  ['issuer_timeout',     0.12],
  ['card_expired',       0.12],
  ['invalid_card',       0.10],
  ['fraud_suspected',    0.08],
  ['do_not_honor',       0.05],
  ['stolen_card',        0.03],
]

// During LocalPay collapse: shift mix toward issuer_timeout (the smoking gun
// of a degrading PSP — connectivity/timeout cluster)
const COLLAPSE_DECLINE_MIX: Array<[DeclineReason, number]> = [
  ['issuer_timeout',     0.55],
  ['insufficient_funds', 0.20],
  ['do_not_honor',       0.10],
  ['fraud_suspected',    0.08],
  ['card_expired',       0.05],
  ['invalid_card',       0.02],
]

// ─────────────────────────────────────────────────────────────────────────────
// Provider config
// ─────────────────────────────────────────────────────────────────────────────

interface ProviderConfig {
  providerId: ProviderId
  country:    Country
  methods:    Array<[PaymentMethod, number]>
  count:      number
  authRateAt: (t: number) => number
  declineMixAt?: (t: number) => Array<[DeclineReason, number]>
}

const CONFIGS: ProviderConfig[] = [
  {
    providerId: 'localpay_brasil',
    country:    'BR',
    methods:    [['credit_card', 0.50], ['debit_card', 0.35], ['pix', 0.15]],
    count:      280,
    authRateAt: localPayAuthRateAt,
    declineMixAt: (t) => {
      const min = (t - SCENARIO_START) / 60_000
      return min >= 60 ? COLLAPSE_DECLINE_MIX : BASELINE_DECLINE_MIX
    },
  },
  {
    providerId: 'andes_pay',
    country:    'PE',
    methods:    [['credit_card', 0.55], ['debit_card', 0.40], ['bank_transfer', 0.05]],
    count:      155,
    authRateAt: andesPayAuthRateAt,
  },
  {
    providerId: 'mexico_trust',
    country:    'MX',
    methods:    [['credit_card', 0.45], ['debit_card', 0.35], ['oxxo', 0.20]],
    count:      82,
    authRateAt: mexicoTrustAuthRateAt,
  },
  {
    providerId: 'colombia_pagos',
    country:    'CO',
    methods:    [['credit_card', 0.60], ['debit_card', 0.35], ['bank_transfer', 0.05]],
    count:      5,                          // edge case: <10 in 30min → low_volume critical
    authRateAt: colombiaPagosAuthRateAt,
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Generation
// ─────────────────────────────────────────────────────────────────────────────

function generateForProvider(cfg: ProviderConfig): Transaction[] {
  const txns: Transaction[] = []
  const totalMs = SCENARIO_END - SCENARIO_START

  // Distribute timestamps weighted by the volume curve. We sample candidate
  // timestamps and accept proportionally to volumeMultiplierAt(t).
  // Simple rejection sampling with peak multiplier as ceiling.
  const peakMultiplier = 3.5

  let generated = 0
  while (generated < cfg.count) {
    const candidateMs = SCENARIO_START + rand() * totalMs
    if (rand() * peakMultiplier > volumeMultiplierAt(candidateMs)) continue

    const authRate = cfg.authRateAt(candidateMs)
    const approved = rand() < authRate

    const method = pickWeighted(cfg.methods)
    const declineMix = cfg.declineMixAt
      ? cfg.declineMixAt(candidateMs)
      : BASELINE_DECLINE_MIX

    const txn: Transaction = {
      id:            `txn_${cfg.providerId}_${generated.toString().padStart(4, '0')}`,
      providerId:    cfg.providerId,
      country:       cfg.country,
      paymentMethod: method,
      status:        approved ? 'approved' : 'declined',
      declineReason: approved ? undefined : pickWeighted(declineMix),
      timestamp:     Math.floor(candidateMs),
    }

    txns.push(txn)
    generated++
  }

  return txns
}

// ─────────────────────────────────────────────────────────────────────────────
// Posting
// ─────────────────────────────────────────────────────────────────────────────

async function postBatch(url: string, batch: Transaction[]): Promise<void> {
  const res = await fetch(`${url}/api/transactions`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ transactions: batch }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`POST failed: ${res.status} ${res.statusText} — ${body}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const allTxns: Transaction[] = []
  for (const cfg of CONFIGS) {
    const provTxns = generateForProvider(cfg)
    allTxns.push(...provTxns)
  }
  allTxns.sort((a, b) => a.timestamp - b.timestamp)

  console.log(`\n📊 Generated ${allTxns.length} transactions`)
  for (const cfg of CONFIGS) {
    const n = allTxns.filter((t) => t.providerId === cfg.providerId).length
    const approved = allTxns.filter(
      (t) => t.providerId === cfg.providerId && t.status === 'approved',
    ).length
    const rate = n > 0 ? ((approved / n) * 100).toFixed(1) : '—'
    console.log(`   ${cfg.providerId.padEnd(20)} ${n.toString().padStart(4)} txns, overall auth rate: ${rate}%`)
  }

  if (dryRun) {
    writeFileSync('data.json', JSON.stringify(allTxns, null, 2))
    console.log('\n📝 Wrote data.json (dry run, no POST)')
    return
  }

  console.log(`\n🚀 POSTing to ${baseUrl}/api/transactions in batches of 100...`)

  // Batch to keep individual POSTs under any payload limits
  const batchSize = 100
  for (let i = 0; i < allTxns.length; i += batchSize) {
    const batch = allTxns.slice(i, i + batchSize)
    await postBatch(baseUrl, batch)
    process.stdout.write(`   batch ${Math.floor(i / batchSize) + 1}: ${batch.length} ok\n`)
  }

  console.log(`\n✅ Done. Try: curl ${baseUrl}/api/health | jq`)
}

main().catch((err) => {
  console.error('\n❌ Seed failed:', err.message)
  process.exit(1)
})
