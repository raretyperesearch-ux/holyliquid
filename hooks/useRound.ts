'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { getSupabaseBrowser } from '@/lib/supabase/client'

export interface RoundData {
  id: string
  round_number: number
  version: number
  pair: string
  direction: 'long' | 'short'
  position_size: number
  leverage: number
  liq_price: number
  open_price: number
  open_price_ts: string
  current_price: number
  current_value: number
  pnl_usd: number
  pnl_pct: number
  pos_pool: number
  neg_pool: number
  status: string
  result: string | null
  round_seed: string
  betting_closes_at: string
  closes_at: string
  ms_until_lock: number
  ms_until_close: number
}

export interface MyBet {
  side: 'pos' | 'neg'
  amount: number
  estimated_winnings: number
  won?: boolean
  outcome?: string
  actual_winnings?: number
}

export interface LastResult {
  round_id: string
  round_number: number
  outcome: 'win' | 'loss' | 'void'
  bet_amount: number
  bet_side: 'pos' | 'neg' | null
  winnings: number   // total returned to wallet (stake + profit, or refund)
  result_label: string | null
  void_reason: string | null
  seen_at: number
}

interface UseRoundOpts {
  /** Called when a round finishes settling/voiding for THIS user. Use it to refetch balance, etc. */
  onResult?: (result: LastResult) => void
}

export function useRound(accessToken: string | null, opts: UseRoundOpts = {}) {
  const [round, setRound] = useState<RoundData | null>(null)
  const [myBet, setMyBet] = useState<MyBet | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastResult, setLastResult] = useState<LastResult | null>(null)
  const lastVersionRef = useRef(0)
  const lastResultRoundIdRef = useRef<string | null>(null)
  const intervalRef = useRef<NodeJS.Timeout | undefined>(undefined)
  const onResultRef = useRef(opts.onResult)

  useEffect(() => { onResultRef.current = opts.onResult }, [opts.onResult])

  const fetchRound = useCallback(async () => {
    try {
      const headers: HeadersInit = {}
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

      const res = await fetch('/api/rounds/current', { headers, cache: 'no-store' })
      if (!res.ok) return
      const json = await res.json()
      if (json.data?.round) {
        const incoming = json.data.round as RoundData
        let keepCurrent = false
        setRound(prev => {
          if (!prev || prev.id === incoming.id) return incoming
          const now = Date.now()
          const prevClosesAt = new Date(prev.closes_at).getTime()
          if (Number.isFinite(prevClosesAt) && now < prevClosesAt + 1200) {
            keepCurrent = true
            return prev
          }
          return incoming
        })
        if (!keepCurrent) {
          setMyBet(json.data.my_bet)
          lastVersionRef.current = incoming.version
        }
      }
    } catch {}
    finally { setLoading(false) }
  }, [accessToken])

  /**
   * Fetch the just-settled round directly from /api/rounds/[id] which now
   * returns my_bet authoritatively when authenticated. This avoids any race
   * with /api/rounds/current swapping to the next open round.
   */
  const captureResult = useCallback(async (settledRoundId: string) => {
    if (!accessToken) return
    if (lastResultRoundIdRef.current === settledRoundId) return // dedupe
    try {
      const headers: HeadersInit = { Authorization: `Bearer ${accessToken}` }
      const res = await fetch(`/api/rounds/${settledRoundId}`, { headers, cache: 'no-store' })
      if (!res.ok) return
      const json = await res.json()
      const settled = json?.data?.round
      const myBetOnRound = json?.data?.my_bet as
        | { side: 'pos' | 'neg'; amount: number; won: boolean | null; outcome: string | null; winnings: number }
        | null
      if (!settled) return

      // No bet on this round — still notify for balance refresh purposes,
      // but don't surface a banner.
      if (!myBetOnRound) {
        onResultRef.current?.({
          round_id:     settledRoundId,
          round_number: Number(settled.round_number) || 0,
          outcome:      'void',
          bet_amount:   0,
          bet_side:     null,
          winnings:     0,
          result_label: settled.result ?? null,
          void_reason:  settled.void_reason ?? null,
          seen_at:      Date.now(),
        })
        lastResultRoundIdRef.current = settledRoundId
        return
      }

      // Authoritative outcome from the bet row itself
      let outcome: LastResult['outcome']
      if (myBetOnRound.outcome === 'void' || settled.status === 'void') {
        outcome = 'void'
      } else if (myBetOnRound.won === true) {
        outcome = 'win'
      } else if (myBetOnRound.won === false) {
        outcome = 'loss'
      } else {
        // Bet exists but won is null (shouldn't normally happen post-settle)
        outcome = 'void'
      }

      const winnings =
        outcome === 'void' ? myBetOnRound.amount :
        outcome === 'win'  ? myBetOnRound.winnings :
        0

      const lr: LastResult = {
        round_id:     settledRoundId,
        round_number: Number(settled.round_number) || 0,
        outcome,
        bet_amount:   myBetOnRound.amount,
        bet_side:     myBetOnRound.side,
        winnings,
        result_label: settled.result ?? null,
        void_reason:  settled.void_reason ?? null,
        seen_at:      Date.now(),
      }
      lastResultRoundIdRef.current = settledRoundId
      setLastResult(lr)
      onResultRef.current?.(lr)
    } catch {}
  }, [accessToken])

  const clearLastResult = useCallback(() => setLastResult(null), [])

  useEffect(() => {
    fetchRound()

    intervalRef.current = setInterval(fetchRound, 2000)

    const sb = getSupabaseBrowser()
    const channel = sb
      .channel('holyliquid:rounds')
      .on('broadcast', { event: 'round_state' }, ({ payload }) => {
        if (payload.version > lastVersionRef.current) {
          fetchRound()
          if (payload.status === 'void' && payload.round_id) {
            captureResult(payload.round_id)
          }
        }
      })
      .on('broadcast', { event: 'round_result' }, ({ payload }) => {
        if (payload?.round_id) captureResult(payload.round_id)
        setTimeout(fetchRound, 500)
      })
      .subscribe()

    return () => {
      clearInterval(intervalRef.current)
      sb.removeChannel(channel)
    }
  }, [accessToken, fetchRound, captureResult])

  return { round, myBet, loading, refetch: fetchRound, lastResult, clearLastResult }
}
