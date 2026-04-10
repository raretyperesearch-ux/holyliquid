'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import { useRound } from '@/hooks/useRound'

const CHIPS = [5, 10, 25, 50, 100]

function fmt(n: number, decimals = 2) {
  return n.toLocaleString('en-US', { maximumFractionDigits: decimals })
}

export default function GamePage() {
  const { ready, authenticated, login, getAccessToken, user } = usePrivy()
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [selectedChip, setSelectedChip] = useState(10)
  const [selectedSide, setSelectedSide] = useState<'pos' | 'neg' | null>(null)
  const [betting, setBetting] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'pos' | 'neg' | 'info' } | null>(null)
  const [countdown, setCountdown] = useState({ lock: 0, close: 0 })
  const toastTimer = useRef<NodeJS.Timeout | undefined>(undefined)

  useEffect(() => {
    if (authenticated) {
      getAccessToken().then(t => setAccessToken(t))
    } else {
      setAccessToken(null)
    }
  }, [authenticated, getAccessToken])

  const { round, myBet, refetch } = useRound(accessToken)

  const fetchBalance = useCallback(async () => {
    if (!accessToken) return
    try {
      const res = await fetch('/api/balance', { headers: { Authorization: `Bearer ${accessToken}` } })
      const json = await res.json()
      if (json.data) setBalance(json.data.available_usdc)
    } catch {}
  }, [accessToken])

  useEffect(() => { if (accessToken) fetchBalance() }, [accessToken, fetchBalance])

  useEffect(() => {
    if (!round) return
    const tick = () => {
      const now = Date.now()
      setCountdown({
        lock:  Math.max(0, new Date(round.betting_closes_at).getTime() - now),
        close: Math.max(0, new Date(round.closes_at).getTime() - now),
      })
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

  async function placeBet() {
    if (!accessToken || !round || !selectedSide) return
    if (countdown.lock <= 0) return showToast('Betting is closed', 'neg')
    if (balance !== null && selectedChip > balance) return showToast('Insufficient balance', 'neg')
    setBetting(true)
    try {
      const res = await fetch('/api/bet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ round_id: round.id, side: selectedSide, amount: selectedChip, idempotency_key: crypto.randomUUID() }),
      })
      const json = await res.json()
      if (json.success) {
        showToast(`Bet placed · $${selectedChip} on ${selectedSide === 'pos' ? '+PNL' : '-PNL'}`, 'pos')
        setBalance(json.data.balance_usdc)
        setSelectedSide(null)
        refetch()
      } else { showToast(json.error || 'Bet failed', 'neg') }
    } catch { showToast('Network error', 'neg') }
    finally { setBetting(false) }
  }

  const isLocked = !round || round.status !== 'open' || countdown.lock <= 0
  const pnlPos = (round?.pnl_usd ?? 0) >= 0

  const phase = !round ? 'loading'
    : round.status === 'open' && countdown.lock > 0 ? 'betting'
    : round.status === 'locked' || (round.status === 'open' && countdown.lock <= 0) ? 'watching'
    : round.status === 'settled' ? 'settled'
    : round.status === 'void' ? 'void'
    : 'loading'

  const timerSec = phase === 'betting' ? Math.ceil(countdown.lock / 1000)
    : Math.ceil(countdown.close / 1000)
  const timerDisplay = phase === 'settled' ? (round?.result ?? '--')
    : phase === 'void' ? 'VOID'
    : `0:${String(timerSec).padStart(2, '0')}`

  const progressPct = phase === 'betting'
    ? (countdown.lock / 10000) * 100
    : (countdown.close / 20000) * 100

  return (
    <div style={{ minHeight: '100vh', background: '#000', color: '#fff', fontFamily: 'var(--font-body)', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto', padding: '24px 16px' }}>

      {/* TOP BAR */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 }}>
        <div>
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.2em', color: '#555', marginBottom: 4, fontWeight: 500 }}>BASE PREDICTION</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', fontWeight: 700, letterSpacing: '0.08em' }}>HOLYLIQUID</div>
        </div>
        {!ready ? null : !authenticated ? (
          <button onClick={login} style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 100, padding: '10px 18px', color: '#fff', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', letterSpacing: '0.05em' }}>
            CONNECT
          </button>
        ) : (
          <div style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 100, padding: '10px 20px', textAlign: 'right' }}>
            <div style={{ fontSize: '0.6rem', letterSpacing: '0.15em', color: '#555', marginBottom: 2 }}>BALANCE</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 700 }}>${balance !== null ? fmt(balance) : '---'}</div>
          </div>
        )}
      </div>

      {/* POSITION CARD */}
      <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 20, padding: '28px 24px', marginBottom: 10 }}>
        {round ? (
          <>
            <div style={{ fontSize: '0.7rem', letterSpacing: '0.15em', color: '#555', marginBottom: 16, fontWeight: 500 }}>
              {round.pair.replace('/USD', '')} {round.direction.toUpperCase()} · {round.leverage}x · ${Math.round(round.position_size / 1000)}K
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(2.8rem, 10vw, 4.5rem)', fontWeight: 700, color: pnlPos ? '#4eff91' : '#ff4e6a', lineHeight: 1, marginBottom: 8, letterSpacing: '-0.02em' }}>
              ${Math.round(round.current_value).toLocaleString()}
            </div>
            {phase === 'settled' && round.result && (
              <div style={{ display: 'inline-block', padding: '4px 14px', borderRadius: 8, background: round.result === '+PNL' ? 'rgba(78,255,145,0.15)' : 'rgba(255,78,106,0.15)', color: round.result === '+PNL' ? '#4eff91' : '#ff4e6a', fontFamily: 'var(--font-display)', fontSize: '0.85rem', fontWeight: 700 }}>
                {round.result}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', color: 'rgba(255,255,255,0.15)', height: 80, display: 'flex', alignItems: 'center' }}>Loading...</div>
        )}
      </div>

      {/* STATS PILL */}
      {round && (
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 100, padding: '10px 20px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '0.85rem', fontWeight: 600, color: pnlPos ? '#4eff91' : '#ff4e6a' }}>
            {pnlPos ? '+' : ''}${fmt(Math.abs(round.pnl_usd), 0)}
          </span>
          <span style={{ color: 'rgba(255,255,255,0.12)' }}>|</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '0.8rem', color: pnlPos ? '#4eff91' : '#ff4e6a' }}>
            {pnlPos ? '+' : ''}{round.pnl_pct.toFixed(2)}%
          </span>
          <span style={{ color: 'rgba(255,255,255,0.12)' }}>|</span>
          <span style={{ fontSize: '0.72rem', color: '#444', letterSpacing: '0.05em', fontWeight: 500 }}>ROUND #{round.round_number}</span>
        </div>
      )}

      {/* STATUS + TIMER */}
      <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 14, padding: '14px 18px', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: phase === 'betting' ? '#4eff91' : phase === 'watching' ? '#facc15' : '#444', boxShadow: phase === 'betting' ? '0 0 8px #4eff91' : 'none' }} />
            <span style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.12em', color: '#888' }}>
              {phase === 'betting' ? 'BETTING OPEN' : phase === 'watching' ? 'BETS LOCKED' : phase === 'settled' ? 'SETTLED' : phase === 'void' ? 'VOID · REFUNDED' : 'LOADING'}
            </span>
          </div>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', fontWeight: 700 }}>{timerDisplay}</span>
        </div>
        <div style={{ height: 4, background: 'rgba(255,255,255,0.07)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', borderRadius: 2, width: `${Math.min(100, progressPct)}%`, background: phase === 'betting' ? 'linear-gradient(90deg, #1A1AFF, #7B2CFF)' : '#facc15', transition: 'width 0.3s linear' }} />
        </div>
        {round && (round.pos_pool > 0 || round.neg_pool > 0) && (
          <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
            <span style={{ fontSize: '0.7rem', color: '#4eff91' }}>+PNL ${fmt(round.pos_pool)}</span>
            <span style={{ fontSize: '0.7rem', color: '#ff4e6a' }}>-PNL ${fmt(round.neg_pool)}</span>
          </div>
        )}
      </div>

      {/* BET PANEL */}
      {authenticated ? (
        myBet && phase !== 'settled' ? (
          <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 20, padding: 24, textAlign: 'center' }}>
            <div style={{ fontSize: '0.65rem', letterSpacing: '0.18em', color: '#555', marginBottom: 8 }}>YOUR BET</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem', fontWeight: 700, color: myBet.side === 'pos' ? '#4eff91' : '#ff4e6a' }}>
              ${myBet.amount} on {myBet.side === 'pos' ? '+PNL' : '-PNL'}
            </div>
            <div style={{ fontSize: '0.75rem', color: '#444', marginTop: 6 }}>Est. return: ${fmt(myBet.estimated_winnings)}</div>
          </div>
        ) : (
          <>
            <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 20, padding: 20, marginBottom: 12 }}>
              <div style={{ fontSize: '0.65rem', letterSpacing: '0.18em', color: '#444', marginBottom: 14, fontWeight: 500 }}>BET AMOUNT</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {CHIPS.map(c => (
                  <button key={c} onClick={() => setSelectedChip(c)} style={{ width: 56, height: 56, borderRadius: '50%', background: selectedChip === c ? '#7B2CFF' : 'rgba(255,255,255,0.07)', border: `2px solid ${selectedChip === c ? '#7B2CFF' : 'rgba(255,255,255,0.1)'}`, color: '#fff', fontFamily: 'var(--font-display)', fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer', boxShadow: selectedChip === c ? '0 0 20px rgba(123,44,255,0.5)' : 'none', transition: 'all 0.15s' }}>
                    ${c}
                  </button>
                ))}
                <button onClick={() => balance && setSelectedChip(Math.min(Math.floor(balance), 500))} style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(255,255,255,0.07)', border: '2px solid rgba(255,255,255,0.1)', color: '#fff', fontFamily: 'var(--font-display)', fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer' }}>
                  MAX
                </button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
              {(['pos', 'neg'] as const).map(side => (
                <button key={side} onClick={() => setSelectedSide(selectedSide === side ? null : side)} disabled={isLocked} style={{ padding: 18, borderRadius: 14, background: selectedSide === side ? (side === 'pos' ? 'rgba(78,255,145,0.12)' : 'rgba(255,78,106,0.12)') : 'rgba(255,255,255,0.04)', border: `2px solid ${selectedSide === side ? (side === 'pos' ? '#4eff91' : '#ff4e6a') : 'rgba(255,255,255,0.1)'}`, color: side === 'pos' ? '#4eff91' : '#ff4e6a', fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 700, letterSpacing: '0.05em', cursor: isLocked ? 'not-allowed' : 'pointer', opacity: isLocked ? 0.35 : 1, transition: 'all 0.15s' }}>
                  {side === 'pos' ? '+PNL' : '−PNL'}
                </button>
              ))}
            </div>
            <button disabled={!selectedSide || isLocked || betting} onClick={placeBet} style={{ width: '100%', padding: 18, borderRadius: 14, background: selectedSide ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.03)', border: `2px solid ${selectedSide ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.07)'}`, color: selectedSide ? '#fff' : '#333', fontFamily: 'var(--font-display)', fontSize: '0.9rem', fontWeight: 700, letterSpacing: '0.1em', cursor: selectedSide && !isLocked ? 'pointer' : 'not-allowed', transition: 'all 0.15s' }}>
              {betting ? 'PLACING...' : 'CONFIRM BET'}
            </button>
          </>
        )
      ) : (
        <div style={{ textAlign: 'center', padding: '32px 0' }}>
          <div style={{ fontSize: '0.72rem', color: '#444', letterSpacing: '0.12em', marginBottom: 16 }}>CONNECT TO PLAY</div>
          <button onClick={login} style={{ padding: '14px 40px', borderRadius: 12, background: 'linear-gradient(135deg, #1A1AFF, #7B2CFF)', border: 'none', color: '#fff', fontFamily: 'var(--font-display)', fontSize: '0.9rem', fontWeight: 700, letterSpacing: '0.08em', cursor: 'pointer' }}>
            CONNECT WALLET
          </button>
        </div>
      )}

      {toast && (
        <div style={{ position: 'fixed', top: 20, left: '50%', transform: 'translateX(-50%)', background: 'rgba(8,8,8,0.97)', border: `1px solid ${toast.type === 'pos' ? '#4eff91' : toast.type === 'neg' ? '#ff4e6a' : '#333'}`, borderRadius: 10, padding: '10px 20px', zIndex: 100, color: toast.type === 'pos' ? '#4eff91' : toast.type === 'neg' ? '#ff4e6a' : '#fff', fontFamily: 'var(--font-display)', fontSize: '0.85rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
          {toast.msg}
        </div>
      )}

      {round && (
        <div style={{ textAlign: 'center', marginTop: 16, opacity: 0.15, fontSize: '0.6rem', letterSpacing: '0.05em' }}>
          seed: {round.round_seed.slice(0, 8)}
        </div>
      )}
    </div>
  )
}
