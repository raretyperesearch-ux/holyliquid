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

// Surfaced to the page so it can show a "you won / lost / refunded" banner
// even if /api/rounds/current has already swapped to the next round.
export interface LastResult {
  round_id: string
  round_number: number
  outcome: 'win' | 'loss' | 'void'
  bet_amount: number
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
  const myBetRef = useRef<MyBet | null>(null)

  // Keep refs fresh without retriggering the subscription effect
  useEffect(() => { onResultRef.current = opts.onResult }, [opts.onResult])
  useEffect(() => { myBetRef.current = myBet }, [myBet])

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
   * After settlement, /api/rounds/current may have already moved on to the next
   * open round. Hit /api/rounds/[id] for the just-settled round directly so we
   * can surface the user's actual result instead of guessing from stale state.
   */
  const captureResult = useCallback(async (settledRoundId: string) => {
    if (!accessToken) return
    if (lastResultRoundIdRef.current === settledRoundId) return // dedupe
    try {
      const headers: HeadersInit = { Authorization: `Bearer ${accessToken}` }

      // Lucky path: /current still points at the settled round and includes my_bet
      const curRes = await fetch('/api/rounds/current', { headers, cache: 'no-store' })
      const curJson = curRes.ok ? await curRes.json() : null
      const curRoundId: string | undefined = curJson?.data?.round?.id
      const curBet = curJson?.data?.my_bet as MyBet | null | undefined
      const curRound = curJson?.data?.round as RoundData | undefined

      if (curRoundId === settledRoundId && curBet && (curRound?.status === 'settled' || curRound?.status === 'void')) {
        const outcome: LastResult['outcome'] =
          curBet.outcome === 'void' ? 'void' :
          curBet.won === true       ? 'win'  :
          curBet.won === false      ? 'loss' : 'void'
        const lr: LastResult = {
          round_id:     settledRoundId,
          round_number: curRound.round_number,
          outcome,
          bet_amount:   Number(curBet.amount) || 0,
          winnings:     Number(curBet.actual_winnings ?? 0) || (outcome === 'void' ? Number(curBet.amount) || 0 : 0),
          result_label: curRound.result ?? null,
          void_reason:  null,
          seen_at:      Date.now(),
        }
        lastResultRoundIdRef.current = settledRoundId
        setLastResult(lr)
        onResultRef.current?.(lr)
        return
      }

      // /current already swapped to the next round — fetch the settled one directly
      const idRes = await fetch(`/api/rounds/${settledRoundId}`, { headers, cache: 'no-store' })
      if (!idRes.ok) return
      const idJson = await idRes.json()
      const settled = idJson?.data?.round
      if (!settled) return

      // /api/rounds/[id] doesn't include my_bet, so use the last-known myBet
      // captured before the round-swap. If we don't have one, the user didn't bet.
      const wasMine = myBetRef.current
      if (!wasMine) {
        // Still notify so balance can refetch even for non-bettors-watching
        onResultRef.current?.({
          round_id:     settledRoundId,
          round_number: Number(settled.round_number) || 0,
          outcome:      'void',
          bet_amount:   0,
          winnings:     0,
          result_label: settled.result ?? null,
          void_reason:  settled.void_reason ?? null,
          seen_at:      Date.now(),
        })
        return
      }

      let outcome: LastResult['outcome'] = 'void'
      let winnings = 0
      if (settled.status === 'void') {
        outcome = 'void'
        winnings = Number(wasMine.amount) || 0 // refund = stake back
      } else if (settled.status === 'settled') {
        const pnlUsd = Number(settled.pnl_usd) || 0
        const winningSide = settled.result === 'LIQUIDATED' || pnlUsd <= 0 ? 'neg' : 'pos'
        const won = wasMine.side === winningSide
        outcome = won ? 'win' : 'loss'
        winnings = won
          ? (Number(wasMine.estimated_winnings) || Number(wasMine.amount) || 0)
          : 0
      }

      const lr: LastResult = {
        round_id:     settledRoundId,
        round_number: Number(settled.round_number) || 0,
        outcome,
        bet_amount:   Number(wasMine.amount) || 0,
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

    // Poll every 2s for price updates
    intervalRef.current = setInterval(fetchRound, 2000)

    // Supabase Realtime for round state changes
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
