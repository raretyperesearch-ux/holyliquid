import express from 'express'
import { getSupabaseClient } from './db'
import { getLastOracleTick } from './oracle'

export function startHealthServer(): void {
  const app = express()

  app.get('/health', async (_req, res) => {
    try {
      const sb = getSupabaseClient()
      const { data: round } = await sb
        .from('hl_rounds')
        .select('id, status, settled_at, round_number')
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      const oracleAgeMs = Date.now() - getLastOracleTick()
      const oracleStale = oracleAgeMs > 5000

      res.json({
        ok:               !oracleStale,
        current_round_id: round?.id ?? null,
        current_status:   round?.status ?? null,
        round_number:     round?.round_number ?? null,
        oracle_fresh:     !oracleStale,
        oracle_age_ms:    oracleAgeMs,
        last_settled_at:  round?.settled_at ?? null,
        ts:               new Date().toISOString(),
      })
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  app.listen(3001, () => {
    console.log('[Health] Listening on :3001/health')
  })
}
