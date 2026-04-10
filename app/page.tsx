'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import dynamic from 'next/dynamic'
import { usePrivy } from '@privy-io/react-auth'
import { useRound } from '@/hooks/useRound'
import { getSound, type SoundName } from '@/lib/sound'

const PriceWaterChart = dynamic(() => import('@/components/game/PriceWaterChart'), { ssr: false })

const CHIPS = [5, 10, 25, 50, 100]

function fmt(n: number) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

type ModalKind = null | 'deposit' | 'withdraw'

type MarqueeKind = 'info' | 'warn' | 'win' | 'loss' | 'success'
interface MarqueeMsg {
  id: number
  text: string
  kind: MarqueeKind
  ttl: number // auto-dismiss ms; 0 = persistent (base state)
}

export default function HolyLiquid() {
  const { ready, authenticated, login, getAccessToken, user } = usePrivy()
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [selectedChip, setSelectedChip] = useState(10)
  const [selectedSide, setSelectedSide] = useState<'pos' | 'neg' | null>(null)
  const [betting, setBetting] = useState(false)
  const [toast, setToast] = useState<{ msg: string; color: string } | null>(null)
  const [priceHistory, setPriceHistory] = useState<number[]>([])
  const [countdown, setCountdown] = useState({ lock: 0, close: 0 })
  const toastTimer = useRef<NodeJS.Timeout | undefined>(undefined)

  // Deposit / withdraw modal state
  const [modal, setModal] = useState<ModalKind>(null)
  const [treasuryWallet, setTreasuryWallet] = useState<string | null>(null)
  const [treasuryLoaded, setTreasuryLoaded] = useState(false)
  const [depositTxHash, setDepositTxHash] = useState('')
  const [depositAmount, setDepositAmount] = useState('')
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [withdrawTo, setWithdrawTo] = useState('')
  const [modalBusy, setModalBusy] = useState(false)

  // Settle flash (shown briefly when a round result lands)
  const [settleFlash, setSettleFlash] = useState<'win' | 'loss' | null>(null)
  const lastSettledIdRef = useRef<string | null>(null)

  // Sound
  const [soundEnabled, setSoundEnabled] = useState(true)
  useEffect(() => {
    // Hydrate from localStorage on the client (avoids SSR mismatch)
    setSoundEnabled(getSound().isEnabled())
  }, [])
  const playSound = useCallback((name: SoundName) => {
    getSound().play(name)
  }, [])
  const toggleSound = useCallback(() => {
    const next = !getSound().isEnabled()
    getSound().setEnabled(next)
    setSoundEnabled(next)
    if (next) getSound().play('toggle') // audible confirmation on enable
  }, [])

  // Marquee (top-center floating status popup)
  const [marqueeOverride, setMarqueeOverride] = useState<MarqueeMsg | null>(null)
  const marqueeIdRef = useRef(0)
  const marqueeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flashMarquee = useCallback((text: string, kind: MarqueeKind = 'info', ttl = 2500) => {
    marqueeIdRef.current += 1
    const msg: MarqueeMsg = { id: marqueeIdRef.current, text, kind, ttl }
    setMarqueeOverride(msg)
    if (marqueeTimerRef.current) clearTimeout(marqueeTimerRef.current)
    if (ttl > 0) {
      marqueeTimerRef.current = setTimeout(() => setMarqueeOverride(null), ttl)
    }
  }, [])
  useEffect(() => {
    return () => {
      if (marqueeTimerRef.current) clearTimeout(marqueeTimerRef.current)
    }
  }, [])

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

  // Track price history per round — reset on round rollover and on asset swap.
  // Keyed on round.id so same-pair rollovers also start fresh.
  const lastRoundRef = useRef<string | null>(null)
  useEffect(() => {
    if (!round?.current_price || !round?.pair || !round?.id) return
    if (round.id !== lastRoundRef.current) {
      lastRoundRef.current = round.id
      setPriceHistory([round.current_price])
    } else {
      setPriceHistory(prev => [...prev, round.current_price].slice(-120))
    }
  }, [round?.current_price, round?.id, round?.pair])

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
    if (countdown.lock <= 0) {
      playSound('locked')
      return showToast('Betting is closed', '#ff7c98')
    }
    if (balance !== null && selectedChip > balance) {
      playSound('locked')
      return showToast('Insufficient balance', '#ff7c98')
    }
    playSound('confirm')
    setBetting(true)
    try {
      const res = await fetch('/api/bet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          round_id: round.id, side: selectedSide, amount: selectedChip,
          idempotency_key: crypto.randomUUID(),
        }),
      })
      const json = await res.json()
      if (json.success) {
        showToast(`Bet placed · $${selectedChip} on ${selectedSide === 'pos' ? '+PNL' : '−PNL'}`, '#7df2a8')
        flashMarquee(`BET PLACED · $${selectedChip} · ${selectedSide === 'pos' ? '+PNL' : '−PNL'}`, 'success', 2200)
        setBalance(json.data.balance_usdc)
        setSelectedSide(null)
        refetch()
      } else {
        playSound('locked')
        showToast(json.error || 'Bet failed', '#ff7c98')
      }
    } catch {
      playSound('locked')
      showToast('Network error', '#ff7c98')
    }
    finally { setBetting(false) }
  }

  // Fetch treasury wallet once on first mount so the deposit modal has it ready
  useEffect(() => {
    let cancelled = false
    fetch('/api/deposit')
      .then(r => r.json())
      .then(j => {
        if (cancelled) return
        setTreasuryWallet(j?.data?.treasury_wallet ?? null)
        setTreasuryLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setTreasuryLoaded(true)
      })
    return () => { cancelled = true }
  }, [])

  function openDeposit() {
    setDepositTxHash('')
    setDepositAmount('')
    setModal('deposit')
    playSound('modalOpen')
  }
  function openWithdraw() {
    setWithdrawAmount('')
    // Prefill destination with the user's own wallet if available
    const w = user?.wallet?.address
    setWithdrawTo(w ?? '')
    setModal('withdraw')
    playSound('modalOpen')
  }
  function closeModal() {
    if (modalBusy) return
    setModal(null)
    playSound('modalClose')
  }

  async function submitDeposit() {
    if (!accessToken) return
    const amt = Number(depositAmount)
    if (!depositTxHash || !depositTxHash.startsWith('0x')) {
      playSound('locked')
      return showToast('Enter a valid tx hash', '#ff7c98')
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      playSound('locked')
      return showToast('Enter a valid amount', '#ff7c98')
    }
    setModalBusy(true)
    try {
      const res = await fetch('/api/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ tx_hash: depositTxHash.trim(), amount: amt }),
      })
      const json = await res.json()
      if (json.success) {
        playSound('confirm')
        showToast(`Deposited $${fmt(json.data.amount_credited)}`, '#7df2a8')
        flashMarquee(`DEPOSIT CREDITED · $${fmt(json.data.amount_credited)}`, 'success', 2800)
        // Refetch balance to get consistent available_usdc semantics
        fetchBalance()
        setModal(null)
      } else {
        playSound('locked')
        showToast(json.error || 'Deposit failed', '#ff7c98')
      }
    } catch {
      playSound('locked')
      showToast('Network error', '#ff7c98')
    }
    finally { setModalBusy(false) }
  }

  async function submitWithdraw() {
    if (!accessToken) return
    const amt = Number(withdrawAmount)
    if (!Number.isFinite(amt) || amt <= 0) {
      playSound('locked')
      return showToast('Enter a valid amount', '#ff7c98')
    }
    if (!withdrawTo || !withdrawTo.startsWith('0x')) {
      playSound('locked')
      return showToast('Enter a destination wallet', '#ff7c98')
    }
    if (balance !== null && amt > balance) {
      playSound('locked')
      return showToast('Insufficient balance', '#ff7c98')
    }
    setModalBusy(true)
    try {
      const res = await fetch('/api/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ amount: amt, to_wallet: withdrawTo.trim() }),
      })
      const json = await res.json()
      if (json.success) {
        playSound('confirm')
        showToast(`Withdrew $${fmt(json.data.amount)}`, '#7df2a8')
        flashMarquee(`WITHDRAWAL SENT · $${fmt(json.data.amount)}`, 'success', 2800)
        // Refetch balance to get consistent available_usdc semantics
        fetchBalance()
        setModal(null)
      } else {
        playSound('locked')
        showToast(json.error || 'Withdraw failed', '#ff7c98')
      }
    } catch {
      playSound('locked')
      showToast('Network error', '#ff7c98')
    }
    finally { setModalBusy(false) }
  }

  // When a round settles and the user had a bet, flash the scene green/red
  // + play win/loss sound + push a marquee message with the result.
  useEffect(() => {
    if (!round || round.status !== 'settled') return
    if (lastSettledIdRef.current === round.id) return
    lastSettledIdRef.current = round.id
    let t: ReturnType<typeof setTimeout> | undefined
    if (myBet?.won === true) {
      setSettleFlash('win')
      playSound('win')
      const profit = Number(myBet.actual_winnings ?? myBet.estimated_winnings ?? myBet.amount) - Number(myBet.amount)
      flashMarquee(`★ YOU WON +$${fmt(profit)}`, 'win', 3200)
      t = setTimeout(() => setSettleFlash(null), 1300)
    }
    if (myBet?.won === false) {
      setSettleFlash('loss')
      playSound('loss')
      flashMarquee(`✕ YOU LOST $${fmt(Number(myBet.amount))}`, 'loss', 3200)
      t = setTimeout(() => setSettleFlash(null), 1300)
    }
    return () => { if (t) clearTimeout(t) }
  }, [round?.id, round?.status, myBet?.won, playSound, flashMarquee])

  const isLocked = !round || round.status !== 'open' || countdown.lock <= 0
  const pnlPos   = (round?.pnl_usd ?? 0) >= 0

  const phase = !round ? 'loading'
    : round.status === 'open' && countdown.lock > 0 ? 'betting'
    : round.status === 'locked' || (round.status === 'open' && countdown.lock <= 0) ? 'watching'
    : round.status === 'settled' ? 'settled'
    : round.status === 'void' ? 'void'
    : 'loading'

  // Real round duration derived from backend timestamps — no more hardcoded
  // 10000/20000 magic numbers. open_price_ts is when the round opened.
  // Defensive: if any timestamp is missing/invalid, fall back to 1 so the
  // progress ratio stays finite (width: 0%) instead of NaN.
  const totalBettingMs = (() => {
    if (!round) return 1
    const closes = new Date(round.betting_closes_at).getTime()
    const opens  = new Date(round.open_price_ts).getTime()
    if (!Number.isFinite(closes) || !Number.isFinite(opens) || closes <= opens) return 1
    return closes - opens
  })()
  const totalWatchingMs = (() => {
    if (!round) return 1
    const closes = new Date(round.closes_at).getTime()
    const lock   = new Date(round.betting_closes_at).getTime()
    if (!Number.isFinite(closes) || !Number.isFinite(lock) || closes <= lock) return 1
    return closes - lock
  })()

  const timerSec = phase === 'betting'
    ? Math.ceil(countdown.lock / 1000)
    : Math.ceil(countdown.close / 1000)

  // Final 10 seconds of betting → pulse + "LOCKING SOON"
  const isFinalCountdown = phase === 'betting' && countdown.lock > 0 && countdown.lock <= 10_000

  const timerDisplay = phase === 'settled' ? (round?.result ?? '--')
    : phase === 'void' ? 'VOID'
    : `0:${String(Math.max(0, timerSec)).padStart(2, '0')}`

  const progressPct = phase === 'betting'
    ? (countdown.lock / totalBettingMs) * 100
    : phase === 'watching'
    ? (countdown.close / totalWatchingMs) * 100
    : 0

  const phaseLabel = phase === 'betting'
    ? (isFinalCountdown ? '● LOCKING SOON' : '● BETTING OPEN')
    : phase === 'watching' ? '● WAIT FOR NEXT ROUND'
    : phase === 'settled' ? `● ${round?.result ?? 'SETTLED'}`
    : phase === 'void' ? '● VOID'
    : '● LOADING'

  const phaseColor = phase === 'betting'
    ? (isFinalCountdown ? '#FFB84D' : '#7df2a8')
    : phase === 'watching' ? '#FFB300'
    : '#ff7c98'

  const progColor = phase === 'betting'
    ? (isFinalCountdown
        ? 'linear-gradient(90deg,#FF6A00,#FFB84D,#FFD07A)'
        : 'linear-gradient(90deg,#1A1AFF,#7B2CFF,#9A7BFF)')
    : '#FFB300'

  const posLabel = round
    ? `${round.pair.replace('/USD','')} ${round.direction.toUpperCase()} · ${round.leverage}× · $${Math.round(round.position_size/1000)}k`
    : 'Loading...'

  // Price formatting for the context strip — handles BTC ($60k), ETH ($2k),
  // SOL ($150) with reasonable decimal places.
  function fmtPrice(n: number | undefined | null): string {
    if (n === undefined || n === null || !Number.isFinite(n)) return '---'
    const abs = Math.abs(n)
    const digits = abs >= 1000 ? 0 : abs >= 10 ? 2 : 4
    return '$' + n.toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
  }

  const ctxCountdownLabel = phase === 'betting' ? 'LOCK IN'
    : phase === 'watching' ? 'CLOSES'
    : phase === 'settled' ? 'RESULT'
    : phase === 'void' ? 'VOID'
    : 'LOADING'
  const ctxCountdownValue = phase === 'settled' ? (round?.result ?? '--')
    : phase === 'void' ? '—'
    : phase === 'loading' ? '--'
    : timerDisplay

  // Profit/loss amount on a settled bet
  const settleWon = myBet?.won === true
  const settleProfit = myBet
    ? (settleWon
        ? (Number(myBet.actual_winnings ?? myBet.estimated_winnings ?? myBet.amount) - Number(myBet.amount))
        : -Number(myBet.amount))
    : 0

  // Base marquee — reflects current round lifecycle. Transient events
  // (deposit credited, bet placed, settle result) override this via
  // flashMarquee() for ~2-3s then revert to the base.
  const baseMarquee = useMemo<MarqueeMsg | null>(() => {
    if (!round) return null
    if (phase === 'betting') {
      if (isFinalCountdown) {
        return { id: -1, text: '⚠ LOCKING SOON · PLACE YOUR BET', kind: 'warn', ttl: 0 }
      }
      const asset = round.pair.replace('/USD', '')
      return {
        id: -1,
        text: `● ROUND ${round.round_number} LIVE · ${asset} ${round.direction.toUpperCase()} · ${round.leverage}×`,
        kind: 'info',
        ttl: 0,
      }
    }
    if (phase === 'watching') {
      return { id: -1, text: '● BETS LOCKED · WATCHING THE WATER', kind: 'warn', ttl: 0 }
    }
    if (phase === 'settled') {
      return { id: -1, text: `● ROUND ${round.round_number} ${round.result ?? 'SETTLED'}`, kind: 'info', ttl: 0 }
    }
    if (phase === 'void') {
      return { id: -1, text: '● ROUND VOIDED', kind: 'warn', ttl: 0 }
    }
    return null
  }, [round?.id, round?.round_number, round?.pair, round?.direction, round?.leverage, round?.result, phase, isFinalCountdown])

  const currentMarquee = marqueeOverride ?? baseMarquee

  const cfmText = betting ? 'Placing...'
    : phase === 'watching' ? 'Waiting For Next Round'
    : phase === 'settled' ? 'Waiting For Next Round'
    : phase === 'void' ? 'Round Voided'
    : isLocked ? 'Betting Closed'
    : !selectedSide ? 'Select Side'
    : `${selectedSide === 'pos' ? '+PNL' : '−PNL'} · $${selectedChip} · Place Bet`

  return (
    <div className="hl-root">

      {/* ── SCENE — contains chart + UI in an isolated stacking context ── */}
      <div
        className="hl-scene"
        style={{
          position: 'relative',
          width: '100%',
          minHeight: '100dvh',
          overflow: 'hidden',
          isolation: 'isolate',
        }}
      >
        {/* ── CHART LAYER — scene-contained backdrop ── */}
        <div
          className="hl-chart-layer"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 0,
            pointerEvents: 'none',
          }}
        >
          <PriceWaterChart priceHistory={priceHistory} pnlPos={pnlPos} />
        </div>

        {/* ── SETTLE FLASH — brief color wash over the scene on round result ── */}
        {settleFlash && <div className={`settle-flash ${settleFlash}`} />}

        {/* ── UI ISLANDS — sit on top of chart ── */}
        <div
          className={`hl-ui${phase === 'watching' ? ' is-locked' : ''}`}
          style={{ position: 'relative', zIndex: 1 }}
        >

        {/* HEADER */}
        <div className="hl-hdr">
          <div className="logo-wrap">
            <div className="ltxt">HOLYLIQUID</div>
          </div>
          <div className="hdr-right">
            <button
              className={`sound-toggle${soundEnabled ? ' on' : ''}`}
              onClick={toggleSound}
              title={soundEnabled ? 'Mute sounds' : 'Enable sounds'}
              aria-label={soundEnabled ? 'Mute sounds' : 'Enable sounds'}
            >
              {soundEnabled ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              )}
            </button>
            {!ready ? null : !authenticated ? (
              <button className="isl connect-pill" onClick={login}>Connect</button>
            ) : (
              <div className="isl account-isl">
                <button className="acct-btn deposit" onClick={openDeposit}>Deposit</button>
                <div className="acct-bal">
                  <div className="bl">Balance</div>
                  <div className="bv">{balance !== null ? `$${fmt(balance)}` : '---'}</div>
                </div>
                <button className="acct-btn withdraw" onClick={openWithdraw}>Withdraw</button>
              </div>
            )}
          </div>
        </div>

        {/* ── MARQUEE — floating top-center status pill (reserved slot so
              appearing/disappearing doesn't shift the rest of the column).
              Key encodes id + text so base-state transitions also re-animate. ── */}
        <div className="marquee-slot">
          {currentMarquee && (
            <div
              key={`${currentMarquee.id}:${currentMarquee.text}`}
              className={`marquee-isl ${currentMarquee.kind}`}
            >
              {currentMarquee.text}
            </div>
          )}
        </div>

        {/* ISLAND 1: Position Value */}
        <div className="isl val-isl">
          <div className="vi-lbl">{posLabel}</div>
          <div className={`big-val ${pnlPos ? 'pos' : 'neg'}`}>
            ${round ? Math.round(round.current_value).toLocaleString() : '---'}
          </div>
        </div>

        {/* ISLAND 2: PnL */}
        <div className="isl pnl-isl">
          <span className="pnl-chg" style={{ color: pnlPos ? '#7df2a8' : '#ff7c98' }}>
            {pnlPos ? '+' : ''}${Math.abs(round?.pnl_usd ?? 0).toFixed(2)}
          </span>
          <div className="pnl-div" />
          <span className="pnl-pct">
            {pnlPos ? '+' : ''}{(round?.pnl_pct ?? 0).toFixed(2)}%
          </span>
          <div className="pnl-div" />
          <span className="pnl-round">Round #{round?.round_number ?? '---'}</span>
        </div>

        {/* CONTEXT STRIP: Entry / Now / Lock-in */}
        <div className="isl ctx-isl">
          <div className="ctx-col">
            <div className="ctx-lbl">Entry</div>
            <div className="ctx-val">{fmtPrice(round?.open_price)}</div>
          </div>
          <div className="ctx-div" />
          <div className="ctx-col">
            <div className="ctx-lbl">Now</div>
            <div className={`ctx-val${round ? (pnlPos ? ' pos' : ' neg') : ''}`}>
              {fmtPrice(round?.current_price)}
            </div>
          </div>
          <div className="ctx-div" />
          <div className="ctx-col">
            <div className="ctx-lbl">{ctxCountdownLabel}</div>
            <div className={`ctx-val${isFinalCountdown ? ' locking-soon' : ''}`}>
              {ctxCountdownValue}
            </div>
          </div>
        </div>

        {/* ISLAND 3: Timer */}
        <div className="isl timer-isl">
          <div className="ti-row">
            <span
              className={`phase-lbl${isFinalCountdown ? ' locking-soon' : ''}`}
              style={{ color: phaseColor }}
            >
              {phaseLabel}
            </span>
            <span className={`timer-num${isFinalCountdown ? ' locking-soon' : ''}`}>
              {timerDisplay}
            </span>
          </div>
          <div className="prog-tr">
            <div className="prog-f" style={{ width: `${Math.max(0, Math.min(100, progressPct))}%`, background: progColor }} />
          </div>
        </div>

        {/* boat-zone spacer — keeps flex layout spacing */}
        <div className="boat-zone" />

        {/* BET PANEL */}
        {!authenticated ? (
          <button className="cfm-isl rdy" onClick={login} style={{ letterSpacing: '.2em' }}>
            Connect to Play
          </button>
        ) : phase === 'settled' && myBet ? (
          // Settled round with a bet → show a dramatic result card
          <div className={`isl result-isl ${settleWon ? 'win' : 'loss'}`}>
            <div className="result-lbl">
              {settleWon ? '★ You Won' : '✕ You Lost'}
            </div>
            <div className="result-amt">
              {settleWon ? '+' : ''}${fmt(settleProfit)}
            </div>
            <div className="result-meta">
              ${fmt(myBet.amount)} on {myBet.side === 'pos' ? '+PNL' : '−PNL'}
              {round?.result ? ` · ${round.result}` : ''}
              {round?.round_number ? ` · Round #${round.round_number}` : ''}
            </div>
          </div>
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
                    onClick={() => { setSelectedChip(c); playSound('chip') }}
                  >
                    ${c}
                  </div>
                ))}
                <div
                  className="chip"
                  style={{ fontSize: 9 }}
                  onClick={() => {
                    if (balance) {
                      setSelectedChip(Math.min(Math.floor(balance), 500))
                      playSound('chip')
                    }
                  }}
                >
                  MAX
                </div>
              </div>
            </div>

            {/* ISLANDS 5a & 5b */}
            <div className="btns-row">
              <button
                className={`sb sb-pos${selectedSide === 'pos' ? ' on' : ''}${isLocked ? ' sb-locked' : ''}`}
                disabled={isLocked}
                onClick={() => {
                  setSelectedSide(prev => prev === 'pos' ? null : 'pos')
                  playSound('side')
                }}
              >+PNL</button>
              <button
                className={`sb sb-neg${selectedSide === 'neg' ? ' on' : ''}${isLocked ? ' sb-locked' : ''}`}
                disabled={isLocked}
                onClick={() => {
                  setSelectedSide(prev => prev === 'neg' ? null : 'neg')
                  playSound('side')
                }}
              >−PNL</button>
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
      </div>

      {/* ── DEPOSIT / WITHDRAW MODAL ── */}
      {modal && (
        <div className="modal-backdrop" onClick={closeModal}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            {modal === 'deposit' && (
              <>
                <div className="modal-title">Deposit USDC</div>
                <div className="modal-sub">
                  Send USDC on <strong>Base</strong> to the treasury wallet below, then paste the transaction hash here to credit your balance.
                </div>
                <div className="modal-field">
                  <label>Treasury Wallet</label>
                  <div className="modal-addr" title="Click to select">
                    {treasuryWallet
                      ? treasuryWallet
                      : treasuryLoaded
                        ? 'Deposit address unavailable — contact support'
                        : 'Loading...'}
                  </div>
                </div>
                <div className="modal-field">
                  <label>Amount (USDC)</label>
                  <input
                    className="modal-input"
                    type="number"
                    inputMode="decimal"
                    placeholder="10.00"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                  />
                </div>
                <div className="modal-field">
                  <label>Transaction Hash</label>
                  <input
                    className="modal-input mono"
                    type="text"
                    placeholder="0x..."
                    value={depositTxHash}
                    onChange={(e) => setDepositTxHash(e.target.value)}
                  />
                </div>
                <div className="modal-btns">
                  <button className="mb cancel" disabled={modalBusy} onClick={closeModal}>Cancel</button>
                  <button className="mb submit" disabled={modalBusy || !treasuryWallet} onClick={submitDeposit}>
                    {modalBusy ? 'Verifying...' : 'Credit Deposit'}
                  </button>
                </div>
              </>
            )}

            {modal === 'withdraw' && (
              <>
                <div className="modal-title">Withdraw USDC</div>
                <div className="modal-sub">
                  Withdraw USDC on <strong>Base</strong> to any wallet. Minimum $1, maximum $10,000 per withdrawal.
                </div>
                <div className="modal-field">
                  <label>Amount (USDC)</label>
                  <input
                    className="modal-input"
                    type="number"
                    inputMode="decimal"
                    placeholder="10.00"
                    value={withdrawAmount}
                    onChange={(e) => setWithdrawAmount(e.target.value)}
                  />
                </div>
                <div className="modal-field">
                  <label>Destination Wallet</label>
                  <input
                    className="modal-input mono"
                    type="text"
                    placeholder="0x..."
                    value={withdrawTo}
                    onChange={(e) => setWithdrawTo(e.target.value)}
                  />
                </div>
                {balance !== null && (
                  <div className="modal-sub" style={{ textAlign: 'right' }}>
                    Available: <strong style={{ color: '#7df2a8' }}>${fmt(balance)}</strong>
                  </div>
                )}
                <div className="modal-btns">
                  <button className="mb cancel" disabled={modalBusy} onClick={closeModal}>Cancel</button>
                  <button className="mb submit" disabled={modalBusy} onClick={submitWithdraw}>
                    {modalBusy ? 'Sending...' : 'Withdraw'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* TOAST */}
      {toast && (
        <div className="hl-toast" style={{ color: toast.color, borderColor: toast.color + '44' }}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
