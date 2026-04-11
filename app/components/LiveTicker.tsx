'use client'

import { useEffect, useState, useRef } from 'react'
import { getSupabaseBrowser } from '@/lib/supabase/client'

type TickerEvent = {
  id: string
  type: 'bet' | 'win' | 'loss'
  amount: number
  side?: 'pos' | 'neg'
  ts: number
}

const MAX_EVENTS = 12
const EVENT_LIFETIME_MS = 18000

function formatAmount(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  if (n >= 100) return `$${n.toFixed(0)}`
  return `$${n.toFixed(n < 10 ? 2 : 0)}`
}

export function LiveTicker() {
  const [events, setEvents] = useState<TickerEvent[]>([])
  const eventsRef = useRef<TickerEvent[]>([])

  const addEvent = (e: TickerEvent) => {
    eventsRef.current = [e, ...eventsRef.current].slice(0, MAX_EVENTS)
    setEvents(eventsRef.current)
  }

  useEffect(() => {
    const supabase = getSupabaseBrowser()
    const channel = supabase
      .channel('hl_live_ticker')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'hl_bets' },
        (payload) => {
          const bet: any = payload.new
          if (!bet?.amount) return
          addEvent({
            id: `bet-${bet.id || crypto.randomUUID()}`,
            type: 'bet',
            amount: Number(bet.amount),
            side: bet.side,
            ts: Date.now(),
          })
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'hl_bets' },
        (payload) => {
          const bet: any = payload.new
          if (bet?.outcome == null) return
          if (bet.outcome === 'win') {
            addEvent({
              id: `win-${bet.id}`,
              type: 'win',
              amount: Number(bet.winnings) || 0,
              ts: Date.now(),
            })
          } else if (bet.outcome === 'loss') {
            addEvent({
              id: `loss-${bet.id}`,
              type: 'loss',
              amount: Number(bet.amount) || 0,
              ts: Date.now(),
            })
          }
        }
      )
      .subscribe()

    return () => {
      getSupabaseBrowser().removeChannel(channel)
    }
  }, [])

  // Cull events older than EVENT_LIFETIME_MS
  useEffect(() => {
    const interval = setInterval(() => {
      const cutoff = Date.now() - EVENT_LIFETIME_MS
      eventsRef.current = eventsRef.current.filter((e) => e.ts > cutoff)
      setEvents([...eventsRef.current])
    }, 2000)
    return () => clearInterval(interval)
  }, [])

  if (events.length === 0) {
    return <div className="live-ticker live-ticker--empty" aria-hidden="true" />
  }

  return (
    <div className="live-ticker" aria-label="Live activity feed">
      <div className="live-ticker__inner">
        {events.map((e) => (
          <div key={e.id} className={`tick-item tick-item--${e.type}`}>
            {e.type === 'bet' && (
              <>
                <span className="tick-verb">BET</span>
                <span className="tick-amount">{formatAmount(e.amount)}</span>
                <span className={`tick-side tick-side--${e.side}`}>
                  {e.side === 'pos' ? 'LONG' : 'SHORT'}
                </span>
              </>
            )}
            {e.type === 'win' && (
              <>
                <span className="tick-verb tick-verb--win">WON</span>
                <span className="tick-amount tick-amount--win">+{formatAmount(e.amount)}</span>
              </>
            )}
            {e.type === 'loss' && (
              <>
                <span className="tick-verb tick-verb--loss">LOST</span>
                <span className="tick-amount tick-amount--loss">−{formatAmount(e.amount)}</span>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
