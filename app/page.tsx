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

export default function HolyLiquid() {
  const { ready, authenticated, login, getAccessToken, user } = usePrivy()
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [selectedChip, setSelectedChip] = useState(10)
  const [selectedSide, setSelectedSide] = useState<'pos' | 'neg' | null>(null)
  const [betting, setBetting] = useState(false)
  const [toast, setToast] = useState<{ msg: string; color: string } | null>(null)
  const [countdown, setCountdown] = useState({ lock: 0, close: 0 })
  const [waterPct, setWaterPct] = useState(36)
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

  function showToast(msg: string, color: string) {
    clearTimeout(toastTimer.current)
    setToast({ msg, color })
    toastTimer.current = setTimeout(() => setToast(null), 3000)
  }

  async function placeBet() {
    if (!accessToken || !round || !selectedSide) return
    if (countdown.lock <= 0) return showToast('Betting is closed', '#ff7c98')
    if (balance !== null && selectedChip > balance) return showToast('Insufficient balance', '#ff7c98')
    setBetting(true)
    try {
      const res = await fetch('/api/bet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          round_id: round.id,
          side: selectedSide,
          amount: selectedChip,
          idempotency_key: crypto.randomUUID(),
        }),
      })
      const json = await res.json()
      if (json.success) {
        showToast(`Bet placed · $${selectedChip} on ${selectedSide === 'pos' ? '+PNL' : '−PNL'}`, '#7df2a8')
        setBalance(json.data.balance_usdc)
        setSelectedSide(null)
        refetch()
      } else {
        showToast(json.error || 'Bet failed', '#ff7c98')
      }
    } catch {
      showToast('Network error', '#ff7c98')
    } finally {
      setBetting(false)
    }
  }

  const isLocked = !round || round.status !== 'open' || countdown.lock <= 0
  const pnlUsd = round?.pnl_usd ?? 0
  const pnlPct = round?.pnl_pct ?? 0
  const pnlPos = pnlUsd >= 0
  const currentValue = round?.current_value ?? 347000

  // Water level drives tide: pnl as % of position * leverage
  const waterLevel = round
    ? Math.max(-2.5, Math.min(2.8, (pnlUsd / (round.position_size || 1)) * round.leverage * 100 * 0.22))
    : 0

  const phase = !round ? 'loading'
    : round.status === 'open' && countdown.lock > 0 ? 'betting'
    : round.status === 'locked' || (round.status === 'open' && countdown.lock <= 0) ? 'watching'
    : round.status === 'settled' ? 'settled'
    : round.status === 'void' ? 'void'
    : 'loading'

  const timerSec = phase === 'betting' ? Math.ceil(countdown.lock / 1000) : Math.ceil(countdown.close / 1000)
  const timerDisplay = phase === 'settled' ? (round?.result ?? '--')
    : phase === 'void' ? 'VOID'
    : `0:${String(Math.max(0, timerSec)).padStart(2, '0')}`

  const progressWidth = phase === 'betting'
    ? (countdown.lock / 10000) * 100
    : (countdown.close / 20000) * 100

  const phaseLabel = phase === 'betting' ? '● BETTING OPEN'
    : phase === 'watching' ? '● BETS LOCKED'
    : phase === 'settled' ? `● ${round?.result ?? 'SETTLED'}`
    : phase === 'void' ? '● VOID'
    : '● LOADING'

  const phaseColor = phase === 'betting' ? '#7df2a8'
    : phase === 'watching' ? '#FFB300'
    : phase === 'settled' ? (round?.result === '+PNL' ? '#7df2a8' : '#ff7c98')
    : '#ff7c98'

  const progColor = phase === 'betting'
    ? 'linear-gradient(90deg,#1A1AFF,#7B2CFF,#9A7BFF)'
    : '#FFB300'

  const posLabel = round
    ? `${round.pair.replace('/USD', '')} ${round.direction.toUpperCase()} · ${round.leverage}× · $${Math.round(round.position_size / 1000)}k`
    : 'Loading...'

  const cfmText = betting ? 'Placing...'
    : !selectedSide ? 'Confirm Bet'
    : `${selectedSide === 'pos' ? '+PNL' : '−PNL'} · $${selectedChip} · Confirm`

  return (
    <div className="hl-root">

      {/* Three.js canvas */}
      <GameCanvas waterLevel={waterLevel} onWaterPct={setWaterPct} />

      {/* CSS Water */}
      <div className="hl-water" style={{ height: `${waterPct}%` }}>
        <div className="ww">
          <svg className="w1" viewBox="0 0 1200 160" preserveAspectRatio="none">
            <path d="M0,54 C100,20 180,86 280,50 C360,22 460,88 560,46 C640,14 760,86 860,50 C980,18 1080,84 1200,48 L1200,160 L0,160 Z" fill="rgba(186,226,255,0.58)"/>
          </svg>
          <svg className="w2" viewBox="0 0 1200 170" preserveAspectRatio="none">
            <path d="M0,62 C120,32 190,94 320,58 C420,30 510,100 650,60 C780,22 900,92 1040,54 C1110,32 1160,56 1200,58 L1200,170 L0,170 Z" fill="rgba(114,154,255,0.48)"/>
          </svg>
          <svg className="w3" viewBox="0 0 1200 160" preserveAspectRatio="none">
            <path d="M0,48 C90,10 220,82 330,44 C430,16 550,88 660,48 C800,6 920,88 1040,50 C1120,24 1170,50 1200,46 L1200,160 L0,160 Z" fill="rgba(80,88,255,0.38)"/>
          </svg>
        </div>
        <div className="water-body" />
      </div>

      {/* UI Islands */}
      <div className="hl-ui">

        {/* HEADER */}
        <div className="hl-hdr">
          <div className="logo-wrap">
            <div className="lsub">Base Prediction</div>
            <div className="ltxt">HOLYLIQUID</div>
          </div>
          {!ready ? null : !authenticated ? (
            <button className="isl connect-pill" onClick={login}>Connect</button>
          ) : (
            <div className="isl bal-isl">
              <div className="bl">Balance</div>
              <div className="bv">{balance !== null ? `$${fmt(balance)}` : '---'}</div>
            </div>
          )}
        </div>

        {/* ISLAND 1: Position Value */}
        <div className="isl val-isl">
          <div className="vi-lbl">{posLabel}</div>
          <div className={`big-val ${pnlPos ? 'pos' : 'neg'}`}>
            ${Math.round(currentValue).toLocaleString()}
          </div>
        </div>

        {/* ISLAND 2: PnL */}
        <div className="isl pnl-isl">
          <span className="pnl-chg" style={{ color: pnlPos ? '#7df2a8' : '#ff7c98' }}>
            {pnlPos ? '+' : ''}${Math.abs(pnlUsd).toFixed(2)}
          </span>
          <div className="pnl-div" />
          <span className="pnl-pct">
            {pnlPos ? '+' : ''}{pnlPct.toFixed(2)}%
          </span>
          <div className="pnl-div" />
          <span className="pnl-round">Round #{round?.round_number ?? '---'}</span>
        </div>

        {/* ISLAND 3: Timer */}
        <div className="isl timer-isl">
          <div className="ti-row">
            <span className="phase-lbl" style={{ color: phaseColor }}>{phaseLabel}</span>
            <span className="timer-num">{timerDisplay}</span>
          </div>
          <div className="prog-tr">
            <div className="prog-f" style={{ width: `${Math.min(100, progressWidth)}%`, background: progColor }} />
          </div>
        </div>

        {/* Boat visible here */}
        <div className="boat-zone" />

        {/* Bet panel — only show if authenticated */}
        {!authenticated ? (
          <button className="cfm-isl rdy" onClick={login} style={{ letterSpacing: '.2em' }}>
            Connect to Play
          </button>
        ) : myBet && phase !== 'settled' ? (
          <div className="isl" style={{ width: '100%', padding: '14px 22px', textAlign: 'center' }}>
            <div style={{ fontSize: 9, letterSpacing: '.3em', color: 'rgba(255,255,255,.3)', textTransform: 'uppercase', marginBottom: 4 }}>Your Bet</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: myBet.side === 'pos' ? '#7df2a8' : '#ff7c98' }}>
              ${myBet.amount} on {myBet.side === 'pos' ? '+PNL' : '−PNL'} · Est. ${fmt(myBet.estimated_winnings)}
            </div>
          </div>
        ) : (
          <>
            {/* ISLAND 4: Chips */}
            <div className="isl chips-isl">
              <div className="ci-lbl">Bet Amount</div>
              <div className="chips-row">
                {CHIPS.map(c => (
                  <div
                    key={c}
                    className={`chip${selectedChip === c ? ' sel' : ''}`}
                    onClick={() => setSelectedChip(c)}
                  >
                    ${c}
                  </div>
                ))}
                <div
                  className="chip"
                  style={{ fontSize: 9 }}
                  onClick={() => balance && setSelectedChip(Math.min(Math.floor(balance), 500))}
                >
                  MAX
                </div>
              </div>
            </div>

            {/* ISLANDS 5a & 5b: +PNL / -PNL */}
            <div className="btns-row">
              <button
                className={`sb sb-pos${selectedSide === 'pos' ? ' on' : ''}`}
                disabled={isLocked}
                onClick={() => setSelectedSide(prev => prev === 'pos' ? null : 'pos')}
              >
                +PNL
              </button>
              <button
                className={`sb sb-neg${selectedSide === 'neg' ? ' on' : ''}`}
                disabled={isLocked}
                onClick={() => setSelectedSide(prev => prev === 'neg' ? null : 'neg')}
              >
                −PNL
              </button>
            </div>

            {/* ISLAND 6: Confirm */}
            <button
              className={`cfm-isl${selectedSide && !isLocked ? ' rdy' : ''}`}
              disabled={!selectedSide || isLocked || betting}
              onClick={placeBet}
            >
              {cfmText}
            </button>
          </>
        )}

      </div>

      {/* Toast */}
      {toast && (
        <div className="hl-toast" style={{ color: toast.color, borderColor: toast.color + '44' }}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
