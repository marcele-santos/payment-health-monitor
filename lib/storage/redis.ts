// lib/storage/redis.ts
//
// Upstash Redis-backed implementation of TransactionStore.
// Survives cold starts on Vercel serverless — each route invocation
// connects to the same backing store via REST API.
//
// Storage layout:
//   txn:<id>                  → Transaction (auto-serialized JSON)
//   txn-index:<providerId>    → sorted set, score = timestamp, member = txn id
//   txn-all                   → sorted set, score = timestamp, member = txn id

import { Redis } from '@upstash/redis'
import type {
  Transaction,
  TransactionStore,
  ProviderId,
} from '@/lib/domain/types'

// Vercel Marketplace injects KV_REST_API_URL and KV_REST_API_TOKEN.
// Same names used in .env.local for local dev.
const redis = new Redis({
  url:   process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
})

const KEY_TXN    = (id: string)     => `txn:${id}`
const KEY_BY_PSP = (id: ProviderId) => `txn-index:${id}`
const KEY_ALL    = 'txn-all'

export class RedisTransactionStore implements TransactionStore {
  async ingest(txns: Transaction[]): Promise<number> {
    if (txns.length === 0) return 0

    // Pipeline = single round-trip for the whole batch
    const pipe = redis.pipeline()
    for (const t of txns) {
      pipe.set(KEY_TXN(t.id), t)                                                // upstash auto-serializes
      pipe.zadd(KEY_BY_PSP(t.providerId), { score: t.timestamp, member: t.id })
      pipe.zadd(KEY_ALL,                   { score: t.timestamp, member: t.id })
    }
    await pipe.exec()
    return txns.length
  }

  async getAll(): Promise<Transaction[]> {
    const ids = (await redis.zrange(KEY_ALL, 0, -1)) as string[]
    return this.hydrate(ids)
  }

  async getByProvider(providerId: ProviderId, sinceMs?: number): Promise<Transaction[]> {
    const min = sinceMs ?? 0
    const ids = (await redis.zrange(KEY_BY_PSP(providerId), min, '+inf', {
      byScore: true,
    })) as string[]
    return this.hydrate(ids)
  }

  async count(): Promise<number> {
    return await redis.zcard(KEY_ALL)
  }

  async clear(): Promise<void> {
    // Brittle but fine for v0: enumerate known providers + scan ids.
    // Production would use a per-tenant namespace + FLUSHDB on test envs only.
    const allIds = (await redis.zrange(KEY_ALL, 0, -1)) as string[]
    if (allIds.length === 0) return

    const pipe = redis.pipeline()
    for (const id of allIds) pipe.del(KEY_TXN(id))
    pipe.del(KEY_ALL)
    pipe.del(KEY_BY_PSP('localpay_brasil'))
    pipe.del(KEY_BY_PSP('andes_pay'))
    pipe.del(KEY_BY_PSP('mexico_trust'))
    pipe.del(KEY_BY_PSP('colombia_pagos'))
    await pipe.exec()
  }

  private async hydrate(ids: string[]): Promise<Transaction[]> {
    if (ids.length === 0) return []
    const pipe = redis.pipeline()
    for (const id of ids) pipe.get(KEY_TXN(id))
    const results = (await pipe.exec()) as (Transaction | null)[]
    return results.filter((t): t is Transaction => t !== null)
  }
}

// Singleton — route handlers import this
export const store = new RedisTransactionStore()
