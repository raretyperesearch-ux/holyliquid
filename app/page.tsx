'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { usePrivy } from '@privy-io/react-auth'
import { useRound } from '@/hooks/useRound'

const GameCanvas = dynamic(() => import('@/components/game/GameCanvas'), { ssr: false })

const CHIPS = [5, 10, 25, 50, 100]

function fmt(n: number) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function fmtPrice(n: number) {
  if (n > 10000) return '$' + Math.round(n).toLocaleString()
  return '$' + n.toFixed(2)
}

export default function GamePage() {
  const { ready, authenticated, login, getAccessToken, user } = usePrivy()
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [selectedChip, setSelectedChip] = useState(10)
  const [betting, setBetting] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'pos' | 'neg' | 'info' } | null>(null)
  const [priceHistory, setPriceHistory] = useState<number[]>([])
  const [countdown, setCountdown] = useState({ lock: 0, close: 0 })
  const toastTimer = useRef<NodeJS.Timeout>()

  // Get access token when authenticated
  useEffect(() => {
    if (authenticated) {
      getAccessToken().then(t => setAccessToken(t))
    } else {
      setAccessToken(null)
    }
  }, [authenticated])

  const { round, myBet, refetch } = useRound(accessToken)

  // Fetch balance
  const fetchBalance = useCallback(async () => {
    if (!accessToken) return
    try {
      const res = await fetch('/api/balance', {
        headers: { Authorization: `Bearer ${accessToken}` }
      })
      const json = await res.json()
      if (json.data) setBalance(json.data.available_usdc)
    } catch {}
  }, [accessToken])

  useEffect(() => {
    if (accessToken) fetchBalance()
  }, [accessToken, fetchBalance])

  // Price history for chart
  useEffect(() => {
    if (!round?.current_price) return
    setPriceHistory(prev => {
      const next = [...prev, round.current_price]
      return next.slice(-60)
    })
  }, [round?.current_price])

  // Countdown timer
  useEffect(() => {
    if (!round) return
    const tick = () => {
      const now = Date.now()
      const lock  = Math.max(0, new Date(round.betting_closes_at).getTime() - now)
      const close = Math.max(0, new Date(round.closes_at).getTime() - now)
      setCountdown({ lock, close })
    }
    tick()
    const id = setInterval(tick, 100)
    return () => clearInterval(id)
  }, [round?.id, round?.betting_closes_at, round?.closes_at])

  function showToast(msg: string, type: 'pos' | 'neg' | 'info' = 'info') {
    clearTimeout(toastTimer.current)
    setToast({ msg, type })
    toastTimer.current = setTimeout(() => setToast(null), 3000)
  }

  async function placeBet(side: 'pos' | 'neg') {
    if (!accessToken || !round || round.status !== 'open') return
    if (countdown.lock <= 0) return showToast('Betting is closed', 'neg')
    if (balance !== null && selectedChip > balance) return showToast('Insufficient balance', 'neg')

    setBetting(true)
    try {
      const res = await fetch('/api/bet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          round_id: round.id,
          side,
          amount: selectedChip,
          idempotency_key: crypto.randomUUID(),
        }),
      })
      const json = await res.json()
      if (json.success) {
        showToast(`Bet placed · $${selectedChip} on ${side === 'pos' ? '+PNL' : '-PNL'}`, 'pos')
        setBalance(json.data.balance_usdc)
        refetch()
      } else {
        showToast(json.error || 'Bet failed', 'neg')
      }
    } catch {
      showToast('Network error', 'neg')
    } finally {
      setBetting(false)
    }
  }

  const isLocked = round?.status !== 'open' || countdown.lock <= 0
  const isLiquidating = round && round.current_price <= round.liq_price && round.direction === 'long'
    || round && round.current_price >= round.liq_price && round.direction === 'short'

  const lockPct  = round ? Math.min(100, (countdown.lock / 10000) * 100) : 0
  const closePct = round ? Math.min(100, (countdown.close / 30000) * 100) : 0
  const timerPct = isLocked ? closePct : lockPct

  const pnlPos = round ? round.pnl_usd >= 0 : true

  // Phase display
  const phase = !round ? 'loading'
    : round.status === 'open' && countdown.lock > 0 ? 'betting'
    : round.status === 'locked' || (round.status === 'open' && countdown.lock <= 0) ? 'watching'
    : round.status === 'settled' ? 'settled'
    : round.status === 'void' ? 'void'
    : 'loading'

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', overflow: 'hidden', background: '#030310' }}>

      {/* Three.js Ocean */}
      <GameCanvas
        pnlPct={round?.pnl_pct ?? 0}
        currentPrice={round?.current_price ?? 0}
        priceHistory={priceHistory}
      />

      {/* ─── TOP BAR ───────────────────────────────────────── */}
      <div style={{
        position: 'absolute', top: 20, left: 0, right: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 24px', zIndex: 10,
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="live-dot" />
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 700, letterSpacing: '0.1em', color: '#fff' }}>
            HOLY<span style={{ color: 'var(--blue)' }}>LIQUID</span>
          </span>
          {round && (
            <span style={{ fontFamily: 'var(--font-display)', fontSize: '0.65rem', color: 'var(--muted)', letterSpacing: '0.08em' }}>
              #{round.round_number}
            </span>
          )}
        </div>

        {/* Auth / Balance */}
        <div className="island island-sm" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {!ready ? null : !authenticated ? (
            <button className="connect-btn" onClick={login} style={{ padding: '8px 20px', fontSize: '0.8rem' }}>
              Connect Wallet
            </button>
          ) : (
            <>
              {balance !== null && (
                <div style={{ textAlign: 'right' }}>
                  <div className="label">Balance</div>
                  <div className="num-sm" style={{ color: '#fff', marginTop: 2 }}>${fmt(balance)}</div>
                </div>
              )}
              <div style={{
                width: 32, height: 32, borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--blue), var(--purple))',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer',
              }}>
                {user?.wallet?.address?.slice(2, 4).toUpperCase() ?? '??'}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ─── MAIN POSITION ISLAND ──────────────────────────── */}
      {round && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -60%)',
          zIndex: 10, minWidth: 320, maxWidth: 420, width: '90vw',
        }}>
          <div className={`island ${isLiquidating ? 'liq-warning' : ''}`}>
            {/* Header row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className={`badge ${round.direction === 'long' ? 'badge-long' : 'badge-short'}`}>
                  {round.direction === 'long' ? '▲' : '▼'} {round.direction.toUpperCase()}
                </span>
                <span className="label">{round.pair} · {round.leverage}x</span>
              </div>
              <span className="label" style={{ fontSize: '0.65rem' }}>
                ${Math.round(round.position_size).toLocaleString()}
              </span>
            </div>

            {/* Big position value */}
            <div style={{ marginBottom: 4 }}>
              <div className="label">Position Value</div>
              <div className={`num-big ${pnlPos ? 'pnl-pos' : 'pnl-neg'}`} style={{ marginTop: 6 }}>
                ${fmt(round.current_value)}
              </div>
            </div>

            {/* PnL row */}
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16 }}>
              <span className={`num-sm ${pnlPos ? 'pnl-pos' : 'pnl-neg'}`}>
                {pnlPos ? '+' : ''}{fmt(round.pnl_usd)} USD
              </span>
              <span className={`num-sm ${pnlPos ? 'pnl-pos' : 'pnl-neg'}`} style={{ opacity: 0.7 }}>
                {pnlPos ? '+' : ''}{round.pnl_pct.toFixed(2)}%
              </span>
            </div>

            {/* Price row */}
            <div style={{ display: 'flex', gap: 24, marginBottom: 16 }}>
              <div>
                <div className="label">Open</div>
                <div className="num-sm" style={{ marginTop: 4 }}>{fmtPrice(round.open_price)}</div>
              </div>
              <div>
                <div className="label">Current</div>
                <div className="num-sm" style={{ marginTop: 4, color: '#fff' }}>{fmtPrice(round.current_price)}</div>
              </div>
              <div>
                <div className="label">Liq</div>
                <div className="num-sm" style={{ marginTop: 4, color: 'var(--red)' }}>{fmtPrice(round.liq_price)}</div>
              </div>
            </div>

            {/* Timer */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="label">
                {phase === 'betting' ? `${(countdown.lock / 1000).toFixed(1)}s to lock`
                  : phase === 'watching' ? `${(countdown.close / 1000).toFixed(1)}s remaining`
                  : phase === 'settled' ? `${round.result ?? 'SETTLED'}`
                  : phase === 'void' ? 'VOID · REFUNDED'
                  : '...'}
              </span>
              {phase === 'settled' && (
                <span className={`badge ${round.result === '+PNL' ? 'badge-long' : 'badge-short'}`}>
                  {round.result}
                </span>
              )}
            </div>
            <div className="timer-bar-track">
              <div className="timer-bar-fill" style={{
                width: `${timerPct}%`,
                background: phase === 'betting'
                  ? 'linear-gradient(90deg, var(--blue), var(--purple))'
                  : countdown.close < 5000
                  ? 'var(--red)'
                  : 'var(--muted)',
              }} />
            </div>

            {/* Pools */}
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <div style={{ flex: 1, padding: '8px 12px', borderRadius: 10, background: 'rgba(125,242,168,0.08)', border: '1px solid rgba(125,242,168,0.15)' }}>
                <div className="label" style={{ color: 'var(--green)' }}>+PNL Pool</div>
                <div className="num-sm" style={{ color: 'var(--green)', marginTop: 3 }}>${fmt(round.pos_pool)}</div>
              </div>
              <div style={{ flex: 1, padding: '8px 12px', borderRadius: 10, background: 'rgba(255,124,152,0.08)', border: '1px solid rgba(255,124,152,0.15)' }}>
                <div className="label" style={{ color: 'var(--red)' }}>-PNL Pool</div>
                <div className="num-sm" style={{ color: 'var(--red)', marginTop: 3 }}>${fmt(round.neg_pool)}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── BETTING PANEL ─────────────────────────────────── */}
      <div style={{
        position: 'absolute', bottom: 24, left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10, width: '90vw', maxWidth: 420,
      }}>
        {/* My bet indicator */}
        {myBet && (
          <div className="island island-sm" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="label">Your bet</span>
            <span className={`badge ${myBet.side === 'pos' ? 'badge-long' : 'badge-short'}`}>
              ${myBet.amount} on {myBet.side === 'pos' ? '+PNL' : '-PNL'}
            </span>
            {myBet.actual_winnings && (
              <span className="num-sm pnl-pos">+${fmt(myBet.actual_winnings - myBet.amount)}</span>
            )}
          </div>
        )}

        <div className="island">
          {!authenticated ? (
            <div style={{ textAlign: 'center', padding: '8px 0' }}>
              <div className="label" style={{ marginBottom: 12 }}>Connect to place bets</div>
              <button className="connect-btn" onClick={login}>Connect Wallet</button>
            </div>
          ) : myBet && round?.status !== 'settled' ? (
            <div style={{ textAlign: 'center', padding: '8px 0' }}>
              <div className="label" style={{ marginBottom: 8 }}>Bet placed · watching now</div>
              <div className="num-sm" style={{ color: 'var(--muted)' }}>Est. return: ${fmt(myBet.estimated_winnings)}</div>
            </div>
          ) : (
            <>
              {/* Chips */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                {CHIPS.map(c => (
                  <button
                    key={c}
                    className={`chip ${selectedChip === c ? 'active' : ''}`}
                    onClick={() => setSelectedChip(c)}
                  >
                    ${c}
                  </button>
                ))}
                <button
                  className={`chip ${selectedChip === (balance ?? 0) ? 'active' : ''}`}
                  onClick={() => balance && setSelectedChip(Math.min(balance, 500))}
                >
                  MAX
                </button>
              </div>

              {/* Bet buttons */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <button
                  className="bet-btn bet-btn-pos"
                  disabled={isLocked || betting || !round}
                  onClick={() => placeBet('pos')}
                >
                  +PNL
                  {round && round.pos_pool > 0 && (
                    <div style={{ fontSize: '0.65rem', opacity: 0.7, marginTop: 4, fontFamily: 'var(--font-body)' }}>
                      Pool: ${fmt(round.pos_pool)}
                    </div>
                  )}
                </button>
                <button
                  className="bet-btn bet-btn-neg"
                  disabled={isLocked || betting || !round}
                  onClick={() => placeBet('neg')}
                >
                  -PNL
                  {round && round.neg_pool > 0 && (
                    <div style={{ fontSize: '0.65rem', opacity: 0.7, marginTop: 4, fontFamily: 'var(--font-body)' }}>
                      Pool: ${fmt(round.neg_pool)}
                    </div>
                  )}
                </button>
              </div>

              {isLocked && phase === 'watching' && (
                <div style={{ textAlign: 'center', marginTop: 12 }}>
                  <span className="label">Bets locked · watching now</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ─── TOAST ─────────────────────────────────────────── */}
      {toast && (
        <div style={{
          position: 'absolute', top: 90, left: '50%', transform: 'translateX(-50%)',
          zIndex: 20,
        }}>
          <div className={`island island-sm result-flash`} style={{
            borderColor: toast.type === 'pos' ? 'rgba(125,242,168,0.4)' : toast.type === 'neg' ? 'rgba(255,124,152,0.4)' : 'var(--glass-border)',
            color: toast.type === 'pos' ? 'var(--green)' : toast.type === 'neg' ? 'var(--red)' : 'var(--text)',
            fontFamily: 'var(--font-display)', fontSize: '0.85rem', fontWeight: 600,
            whiteSpace: 'nowrap',
          }}>
            {toast.msg}
          </div>
        </div>
      )}

      {/* ─── SEED / FAIRNESS ───────────────────────────────── */}
      {round && (
        <div style={{
          position: 'absolute', bottom: 8, right: 16,
          zIndex: 10, opacity: 0.35,
        }}>
          <span className="num-sm" style={{ fontSize: '0.6rem', letterSpacing: '0.05em' }}>
            seed: {round.round_seed.slice(0, 8)}
          </span>
        </div>
      )}
    </div>
  )
}
