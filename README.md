# Payment Health Monitor — TechnoModa

Real-time multi-window monitoring of payment provider authorization health, with anomaly detection against historical baselines.

Built for the Yuno engineering challenge: *The Lima Flash Sale Collapse*.

**Stack:** TypeScript · Next.js 16 (App Router) · Upstash Redis · Vitest · Vercel

---

## Problem

TechnoModa, a fashion e-commerce platform in Lima, ran a flash sale. One of their Brazilian payment providers (LocalPay Brasil) silently degraded: HTTP 200 responses, but authorization rates collapsed from 78% to 11%. Existing monitoring tracked HTTP errors and latency — not authorization success. Forty-five minutes and ~$180K of abandoned carts later, someone noticed.

This service eliminates the blind spot. It ingests transaction events as they flow through the orchestrator, computes per-provider authorization rates over rolling windows (5/15/60 min), and surfaces three classifications:

- **healthy** — auth rate ≥ 60% in the 15min window
- **degraded** — auth rate 30–59% in the 15min window
- **critical** — auth rate < 30% in 15min, OR fewer than 10 transactions in the last 30min (connectivity dead)

It also tracks each provider's historical baseline and flags anomalous current performance (>20pp below baseline).

---

## Run it

### Prerequisites
- Node 20+
- An Upstash Redis instance (free tier works)

### Local

```bash
git clone https://github.com/marcele-santos/payment-health-monitor
cd payment-health-monitor
npm install

# Copy KV_REST_API_URL and KV_REST_API_TOKEN from Upstash console
cat > .env.local <<EOF
KV_REST_API_URL=https://YOUR-DB.upstash.io
KV_REST_API_TOKEN=YOUR-TOKEN
EOF

npm run dev          # Terminal 1
npm run seed         # Terminal 2 — generates and posts ~520 realistic txns
curl http://localhost:3000/api/health | jq
```

### Deployed

`https://payment-health-monitor.vercel.app` *(replace with your URL)*

To seed the deployed instance:
```bash
npm run seed -- https://payment-health-monitor.vercel.app
```

---

## API

### `POST /api/transactions`
Ingest a batch of transaction events.

```bash
curl -X POST http://localhost:3000/api/transactions \
  -H 'content-type: application/json' \
  -d '{
    "transactions": [{
      "id": "txn_001",
      "providerId": "localpay_brasil",
      "country": "BR",
      "paymentMethod": "credit_card",
      "status": "declined",
      "declineReason": "issuer_timeout",
      "timestamp": 1716480000000
    }]
  }'
```

**Response (201):**
```json
{ "ok": true, "ingested": 1, "totalStored": 1 }
```

Validation enforces a cross-field invariant: `declineReason` must be present iff `status === "declined"`. Bad payloads return 400 with field-level error details.

### `GET /api/transactions`
Smoke-test helper. Returns the total stored count (does not list transactions).

```json
{ "ok": true, "totalStored": 520 }
```

### `GET /api/health`
Health snapshot for all providers + system-level summary.

```bash
curl http://localhost:3000/api/health | jq
```

```json
{
  "ok": true,
  "computedAt": "2026-05-23T10:30:00.000Z",
  "overallStatus": "critical",
  "summary": {
    "total": 4,
    "healthy": 2,
    "degraded": 0,
    "critical": 2,
    "anomalousCount": 1
  },
  "providers": [
    {
      "providerId": "localpay_brasil",
      "providerName": "LocalPay Brasil",
      "country": "BR",
      "status": "critical",
      "authRates": { "5min": 0.1500, "15min": 0.1612, "60min": 0.3041 },
      "totalVolumeLastHour": 280,
      "baselineAuthRate": 0.75,
      "isAnomalous": true,
      "anomalyDelta": -0.5888,
      "criticalReason": "low_auth_rate",
      "computedAt": "2026-05-23T10:30:00.000Z"
    },
    "..."
  ]
}
```

### `GET /api/health/:providerId`
Single-provider health. Returns 404 with the list of valid providers if the ID is unknown.

```bash
curl http://localhost:3000/api/health/localpay_brasil | jq
```

Valid provider IDs: `localpay_brasil`, `andes_pay`, `mexico_trust`, `colombia_pagos`.

---

## What the seed data demonstrates

`npm run seed` generates ~520 transactions over a 2-hour window with deterministic randomness (seed=42 — same output every run). The scenario is anchored so that **the LocalPay Brasil collapse is currently in progress** when the reviewer queries.

| Provider          | Country  | Txns | Scenario |
|-------------------|----------|------|----------|
| LocalPay Brasil   | BR       | ~280 | 75% baseline for 60min, then degrades to ~15% — **currently in collapse** |
| AndesPay          | PE       | ~155 | Stable 72% throughout |
| MexicoTrust       | MX       | ~82  | Stable 70% throughout |
| ColombiaPagos     | CO       | 5    | **Low-volume edge case** — triggers `criticalReason: "low_volume"` |

Volume distribution follows a flash sale curve (pre-sale 1x → peak 3.5x at T+20–80min → tail 1.5x). Local payment methods present per brief: PIX (BR), OXXO (MX).

Decline reason mix shifts during the collapse: baseline is `insufficient_funds`-dominant (50%), but during the LocalPay incident it shifts to `issuer_timeout`-dominant (55%) — the signature of a connectivity-degrading PSP.

---

## Architecture

```
app/api/
  transactions/route.ts        POST ingestion, GET count
  health/route.ts              GET all providers
  health/[providerId]/route.ts GET single provider

lib/
  domain/
    types.ts                   types, provider registry, thresholds
    health.ts                  pure: window metrics, classification, anomaly
  storage/
    redis.ts                   TransactionStore — Upstash impl

scripts/
  seed.ts                      generator + POSTer

tests/
  domain/health.test.ts        21 table-driven tests
```

**Pure-function core.** `lib/domain/health.ts` has no I/O and no clock dependency (except via optional `now` parameter). Window metrics, classification, and anomaly detection are unit-tested with table-driven cases including the LocalPay collapse scenario.

**Storage as an interface.** `TransactionStore` is the contract; `RedisTransactionStore` is the v0 impl. Swapping to Postgres or DynamoDB is a one-file change. Storage keys use sorted sets indexed by timestamp, so window queries are O(log n + m) rather than full scans.

**Validation at the wire edge.** Zod schemas in the route handler reject malformed payloads before they reach the store. Domain types stay clean; wire shape can evolve independently.

---

## Design decisions

**Why authorization rate as the primary signal, not a composite score.**
The brief defines health by auth rate alone in the 15min window. A weighted multi-signal score (auth + latency + errors) would carry richer information but introduces opaque weights the user can't reason about. Pure auth rate is explainable to ops without a glossary.

**Why low-volume triggers critical, not "no opinion".**
A provider with <10 transactions in 30min during a flash sale is not healthy by default — it's a strong signal that routing is broken or the PSP is down. Treating empty windows as "healthy" would mask exactly the failure mode the brief describes. The `criticalReason` field distinguishes `low_auth_rate` from `low_volume` so ops know which playbook to follow.

**Why hard-coded baselines (v0).**
Production should compute baselines from a 7–30 day rolling history. For a 2-hour challenge with synthetic data, hard-coding per-provider baselines in the registry is the honest shortcut — it demonstrates the anomaly detection logic without needing to fake a 30-day backfill. The interface is unchanged when this is upgraded.

**Why deterministic test data (seeded PRNG).**
`mulberry32(42)` makes the dataset reproducible across runs. Re-running `npm run seed` overwrites the same transaction IDs in Redis (same seed = same IDs, same timestamps) rather than appending duplicates. This matters for iterative development.

**Why no in-memory fallback.**
On Vercel serverless, each route invocation may land on a different instance — in-memory state would silently lose data between POST (ingest) and GET (health). Going straight to Upstash Redis from v0 avoids that footgun and keeps local dev and production identical.

---

## Honest tradeoffs

- **Anomaly detection uses a static baseline per provider.** A 75% baseline that's "normally" only 70% on Mondays would generate noise. Real baselines need temporal seasonality (hour-of-day, day-of-week).
- **No alert state.** Each `/api/health` call computes fresh — there's no `resolvedAt` tracking, no dedup. A reviewer polling every 10s sees the same critical condition repeatedly. Production needs alert state.
- **Multi-dimensional breakdowns (Stretch A) not implemented.** Auth rates are computed per provider, not per (provider × country × payment method). The types and storage shape support it; the API layer would need a `?groupBy=` parameter.
- **No transaction listing endpoint.** `GET /api/transactions` returns only the count, not the data. Helpful for evaluation visibility but not implemented — felt like the wrong place to spend time given the brief priorities.
- **`clear()` enumerates known providers explicitly.** Brittle if the registry grows. Production would namespace keys per tenant and FLUSHDB on test envs.

---

## What I'd add in a real sprint

1. Rate-of-change anomaly detection — catch the *slope* of degradation before threshold breach
2. Real historical baseline pipeline (rolling 7d, hourly granularity)
3. Alert state machine with `resolvedAt` + cooldown
4. Stretch A — country × method breakdown
5. Stretch B — user-configurable alert thresholds API
6. Stretch C — decline reason aggregation per provider

---

## Tests

```bash
npm test
```

21 unit tests covering:
- Auth rate calculation across windows + provider isolation
- All classification boundaries (60/30 thresholds, 10-txn volume cutoff)
- Anomaly detection including the LocalPay Brasil collapse scenario (78% → 11%)
- Full `computeProviderHealth` assembly including the low-volume edge case
