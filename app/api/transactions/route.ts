// app/api/transactions/route.ts
//
// Ingestion endpoint per brief Req 1.
// POST /api/transactions accepts a batch of transaction events and stores them.
// GET  /api/transactions returns the total stored count (smoke test helper).
//
// Validation is Zod-driven; reject early on malformed input rather than
// poisoning the store with bad shapes.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { store } from '@/lib/storage/redis'
import type { Transaction } from '@/lib/domain/types'

// ─────────────────────────────────────────────────────────────────────────────
// Schemas — kept in this file because they describe the WIRE format,
// which is decoupled from the domain types (one can evolve without the other).
// ─────────────────────────────────────────────────────────────────────────────

const ProviderIdSchema = z.enum([
  'localpay_brasil',
  'andes_pay',
  'mexico_trust',
  'colombia_pagos',
])

const CountrySchema = z.enum(['PE', 'BR', 'MX', 'CO'])

const PaymentMethodSchema = z.enum([
  'credit_card',
  'debit_card',
  'pix',
  'oxxo',
  'bank_transfer',
])

const AuthStatusSchema = z.enum(['approved', 'declined'])

const DeclineReasonSchema = z.enum([
  'insufficient_funds',
  'issuer_timeout',
  'fraud_suspected',
  'card_expired',
  'invalid_card',
  'do_not_honor',
  'stolen_card',
])

const TransactionSchema = z
  .object({
    id:            z.string().min(1).max(128),
    providerId:    ProviderIdSchema,
    country:       CountrySchema,
    paymentMethod: PaymentMethodSchema,
    status:        AuthStatusSchema,
    declineReason: DeclineReasonSchema.optional(),
    timestamp:     z.number().int().positive(),
  })
  // Enforce the cross-field invariant: declineReason iff status === 'declined'
  .refine(
    (t) =>
      (t.status === 'declined' && t.declineReason !== undefined) ||
      (t.status === 'approved' && t.declineReason === undefined),
    {
      message:
        'declineReason must be present when status is "declined" and absent when "approved"',
    },
  )

const IngestSchema = z.object({
  transactions: z.array(TransactionSchema).min(1).max(10_000),
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/transactions — ingest a batch
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON body' },
      { status: 400 },
    )
  }

  const parsed = IngestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Validation failed',
        details: parsed.error.flatten(),
      },
      { status: 400 },
    )
  }

  try {
    const count = await store.ingest(parsed.data.transactions as Transaction[])
    return NextResponse.json(
      { ok: true, ingested: count, totalStored: await store.count() },
      { status: 201 },
    )
  } catch (err) {
    // Redis connection errors land here — surface as 502 so the client knows
    // it's an upstream problem, not a bad request.
    return NextResponse.json(
      {
        ok: false,
        error: 'Ingest failed',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/transactions — smoke test / debug visibility
// ─────────────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const total = await store.count()
    return NextResponse.json({ ok: true, totalStored: total })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Store unavailable',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    )
  }
}
