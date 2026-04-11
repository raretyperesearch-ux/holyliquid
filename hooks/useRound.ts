'use client'
import { useState, useEffect, useRef } from 'react'
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

export function useRound(accessToken: string | null) {
  const [round, setRound] = useState<RoundData | null>(null)
  const [myBet, setMyBet] = useState<MyBet | null>(null)
  const [loading, setLoading] = useState(true)
  const lastVersionRef = useRef(0)
  const intervalRef = useRef<NodeJS.Timeout | undefined>(undefined)

  const fetchRound = async () => {
    try {
      const headers: HeadersInit = {}
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

      const res = await fetch('/api/rounds/current', {
        headers,
        cache: 'no-store',
      })
      if (!res.ok) return
      const json = await res.json()
      if (json.data?.round) {
        const incoming = json.data.round as RoundData
        let keepCurrent = false
        setRound(prev => {
          if (!prev || prev.id === incoming.id) return incoming
          const now = Date.now()
          const prevClosesAt = new Date(prev.closes_at).getTime()
          if (
            Number.isFinite(prevClosesAt) &&
            now < prevClosesAt + 1200
          ) {
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
  }

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
        }
      })
      .on('broadcast', { event: 'round_result' }, () => {
        setTimeout(fetchRound, 500)
      })
      .subscribe()

    return () => {
      clearInterval(intervalRef.current)
      sb.removeChannel(channel)
    }
  }, [accessToken])

  return { round, myBet, loading, refetch: fetchRound }
}
