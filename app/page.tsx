'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import dynamic from 'next/dynamic'
import { createPortal } from 'react-dom'
import { usePrivy } from '@privy-io/react-auth'
import { useRound, type LastResult } from '@/hooks/useRound'
import { LiveTicker } from './components/LiveTicker'
import { SoundToggle } from './components/SoundToggle'
import { sounds } from '../lib/sounds'
import { encodeFunctionData, parseUnits } from 'viem'

const PriceWaterChart = dynamic(() => import('@/components/game/PriceWaterChart'), { ssr: false })

const CHIPS = [1, 2, 5, 10, 25, 50, 100]
const MVP_ASSET_LABEL = 'ETH'
const WELCOME_SEEN_KEY = 'hl:welcomeSeen:v1'
const SPOTLIGHT_DONE_KEY = 'hl:spotlightDone:v1'

type SpotlightStepId = 'chips' | 'sides' | 'confirm' | 'account'

type SpotlightStep = {
  id: SpotlightStepId
  title: string
  text: string
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function heroFontSize(valueText: string): string {
  const digits = valueText.replace(/[^0-9]/g, '').length
  if (digits >= 14) return '24px'
  if (digits >= 13) return '26px'
  if (digits >= 12) return '29px'
  if (digits >= 11) return '32px'
  if (digits >= 10) return '36px'
  if (digits >= 9) return '40px'
  if (digits >= 8) return '45px'
  return '52px'
}

function pnlFontSize(valueText: string): string {
  const digits = valueText.replace(/[^0-9]/g, '').length
  if (digits >= 10) return '11px'
  if (digits >= 9) return '12px'
  if (digits >= 8) return '13px'
  return '15px'
}

type ModalKind = null | 'deposit' | 'withdraw' | 'custom'
type HistoryRound = {
  round_number: number
  result: 'pos' | 'neg' | 'void' | null
  pnl_pct: number | null
  settled_at: string | null
  pos_pool?: number
  neg_pool?: number
}

function LastResultBanner({
  result,
  lastBetAmount,
  onRebet,
  onDismiss,
}: {
  result: { outcome: '+PNL' | '-PNL' | 'LIQUIDATED' | 'VOID'; pnlPct?: number; pnlUsd?: number; winnings?: number } | null
  lastBetAmount: number | null
  onRebet: (side: 'pos' | 'neg', amount: number) => void
  onDismiss: () => void
}) {
  if (!result) return null

  const isWin  = result.outcome === '+PNL'
  const isLoss = result.outcome === '-PNL'
  const isLiq  = result.outcome === 'LIQUIDATED'
  const isVoid = result.outcome === 'VOID'

  const headline = isWin
    ? `WON $${(result.winnings ?? 0).toFixed(2)}`
    : isLoss
    ? `LOST $${(lastBetAmount ?? 0).toFixed(2)}`
    : isLiq
    ? `LIQUIDATED`
    : `VOIDED`

  const subline = isVoid
    ? 'Round refunded'
    : `${(result.pnlPct ?? 0) > 0 ? '+' : ''}${(result.pnlPct ?? 0).toFixed(2)}%`

  const variant = isWin ? 'win' : isLiq ? 'liq' : isLoss ? 'loss' : 'void'
  const canRebet = lastBetAmount != null && lastBetAmount > 0 && !isVoid

  return (
    <div className="runback" role="status">
      <div className={`runback__card runback__card--${variant}`}>
        <div className="runback__border" aria-hidden />
        <div className="runback__shine" aria-hidden />
        {isWin && (
          <>
            <div className="runback__sparkles" aria-hidden />
            <div className="runback__confetti" aria-hidden />
          </>
        )}
        <button className="runback__close" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>

        <div className="runback__head">
          <div className="runback__headline" data-text={headline}>{headline}</div>
          <div className="runback__sub">{subline}</div>
        </div>

        {canRebet && (
          <>
            <div className="runback__divider" />
            <div className="runback__label">⚡ RUN IT BACK · ${lastBetAmount!.toFixed(2)} ⚡</div>
            <div className="runback__btns">
              <button
                className="runback__btn runback__btn--pos"
                onClick={() => { onRebet('pos', lastBetAmount!); onDismiss() }}
              >
                <span className="runback__btn-glow" aria-hidden />
                <span className="runback__btn-label">+PNL</span>
                <span className="runback__btn-amt">${lastBetAmount!.toFixed(2)}</span>
              </button>
              <button
                className="runback__btn runback__btn--neg"
                onClick={() => { onRebet('neg', lastBetAmount!); onDismiss() }}
              >
                <span className="runback__btn-glow" aria-hidden />
                <span className="runback__btn-label">−PNL</span>
                <span className="runback__btn-amt">${lastBetAmount!.toFixed(2)}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function HolyLiquid() {
  const { ready, authenticated, login, getAccessToken, user } = usePrivy()
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const fetchBalanceRef = useRef<() => Promise<void>>(async () => {})
  const lastBetRef = useRef<{ side: 'pos' | 'neg'; amount: number } | null>(null)
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
  const [depositTokenContract, setDepositTokenContract] = useState<string | null>(null)
  const [treasuryLoaded, setTreasuryLoaded] = useState(false)
  const [depositAmount, setDepositAmount] = useState('')
  const [customAmount, setCustomAmount] = useState('')
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [withdrawTo, setWithdrawTo] = useState('')
  const [modalBusy, setModalBusy] = useState(false)
  const [domReady, setDomReady] = useState(false)
  const [showWelcome, setShowWelcome] = useState(false)
  const [spotlightStep, setSpotlightStep] = useState<number | null>(null)
  const [spotlightRect, setSpotlightRect] = useState<DOMRect | null>(null)
  const [recentRounds, setRecentRounds] = useState<HistoryRound[]>([])
  const [heroFontPx, setHeroFontPx] = useState(52)
  const [pnlFontPx, setPnlFontPx] = useState(15)
  const [timerFontPx, setTimerFontPx] = useState(16)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const heroCardRef = useRef<HTMLDivElement | null>(null)
  const heroTextRef = useRef<HTMLDivElement | null>(null)
  const pnlCardRef = useRef<HTMLDivElement | null>(null)
  const pnlTextRef = useRef<HTMLSpanElement | null>(null)
  const timerCardRef = useRef<HTMLDivElement | null>(null)
  const timerTextRef = useRef<HTMLSpanElement | null>(null)
  const chipsGuideRef = useRef<HTMLDivElement | null>(null)
  const sidesGuideRef = useRef<HTMLDivElement | null>(null)
  const confirmGuideRef = useRef<HTMLButtonElement | null>(null)
  const accountGuideRef = useRef<HTMLElement | null>(null)

  // Settle flash (shown briefly when a round result lands)
  const [settleFlash, setSettleFlash] = useState<'win' | 'loss' | null>(null)
  const [pnlJuice, setPnlJuice] = useState<'win' | 'loss' | 'liq' | null>(null)
  const lastSettledIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (authenticated) {
      getAccessToken().then(t => setAccessToken(t))
    } else {
      setAccessToken(null)
    }
  }, [authenticated, getAccessToken])

  useEffect(() => {
    setDomReady(true)
  }, [])

  useEffect(() => {
    if (!domReady || typeof window === 'undefined') return
    const seen = window.localStorage.getItem(WELCOME_SEEN_KEY) === '1'
    if (!seen) setShowWelcome(true)
  }, [domReady])

  const spotlightSteps: SpotlightStep[] = useMemo(() => [
    { id: 'chips', title: 'Pick Risk', text: 'Pick how much you want to risk.' },
    { id: 'sides', title: 'Choose Side', text: 'Bet whether the leveraged ETH position closes +PNL or −PNL.' },
    { id: 'confirm', title: 'Lock It In', text: 'Place your bet before the round locks.' },
    { id: 'account', title: 'Fund Up', text: 'Fund your balance to start playing fast.' },
  ], [])

  const getStepTarget = useCallback((id: SpotlightStepId) => {
    if (id === 'chips') return chipsGuideRef.current
    if (id === 'sides') return sidesGuideRef.current
    if (id === 'confirm') return confirmGuideRef.current
    return accountGuideRef.current
  }, [])

  const findNextAvailableStep = useCallback((start: number) => {
    for (let i = start; i < spotlightSteps.length; i++) {
      if (getStepTarget(spotlightSteps[i].id)) return i
    }
    return null
  }, [getStepTarget, spotlightSteps])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const raw = window.localStorage.getItem('hl:selectedChip')
    const parsed = raw ? Number(raw) : NaN
    if (CHIPS.includes(parsed)) setSelectedChip(parsed)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('hl:selectedChip', String(selectedChip))
  }, [selectedChip])

  const { round, myBet, refetch, lastResult, clearLastResult } = useRound(accessToken, {
    onResult: useCallback((result: LastResult) => {
      fetchBalanceRef.current()
      // Trigger PNL card juice + casino sound based on the round's position outcome.
      // result_label carries the raw backend outcome (+PNL/-PNL/LIQUIDATED).
      if (result.result_label === '+PNL') {
        setPnlJuice('win')
        sounds.win()
      } else if (result.result_label === '-PNL') {
        setPnlJuice('loss')
        sounds.loss()
      } else if (result.result_label === 'LIQUIDATED') {
        setPnlJuice('liq')
        sounds.liq()
      }
      setTimeout(() => setPnlJuice(null), 1500)
    }, []),
  })

  const fetchBalance = useCallback(async () => {
    if (!accessToken) return
    try {
      const res = await fetch('/api/balance', { headers: { Authorization: `Bearer ${accessToken}` } })
      const json = await res.json()
      if (json.data) setBalance(json.data.available_usdc)
    } catch {}
  }, [accessToken])

  useEffect(() => { fetchBalanceRef.current = fetchBalance }, [fetchBalance])
  useEffect(() => { if (accessToken) fetchBalance() }, [accessToken, fetchBalance])

  // Keep ETH trace continuous across round boundaries for a single live-market feel.
  useEffect(() => {
    if (!round?.current_price || !round?.pair) return
    setPriceHistory(prev => {
      if (!prev.length) return [round.current_price]
      const last = prev[prev.length - 1]
      if (Math.abs(last - round.current_price) < 1e-9) return prev
      return [...prev, round.current_price].slice(-360)
    })
  }, [round?.current_price, round?.pair])

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

  const ensureAudio = useCallback(() => {
    if (typeof window === 'undefined') return null
    const Ctx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return null
    if (!audioCtxRef.current) audioCtxRef.current = new Ctx()
    if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume().catch(() => {})
    return audioCtxRef.current
  }, [])

  const playSfx = useCallback((kind: 'chip' | 'side' | 'confirm' | 'invalid' | 'modalOpen' | 'modalClose' | 'win' | 'loss') => {
    if (sounds.isMuted()) return
    const ctx = ensureAudio()
    if (!ctx) return
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const now = ctx.currentTime
    osc.connect(gain)
    gain.connect(ctx.destination)

    const presets = {
      chip:      { freq: 620, end: 700, dur: 0.06, vol: 0.35, type: 'triangle' as OscillatorType },
      side:      { freq: 420, end: 510, dur: 0.08, vol: 0.4,  type: 'sine' as OscillatorType },
      confirm:   { freq: 360, end: 660, dur: 0.12, vol: 0.5,  type: 'triangle' as OscillatorType },
      invalid:   { freq: 220, end: 170, dur: 0.09, vol: 0.45, type: 'sawtooth' as OscillatorType },
      modalOpen: { freq: 520, end: 430, dur: 0.08, vol: 0.35, type: 'sine' as OscillatorType },
      modalClose:{ freq: 390, end: 290, dur: 0.07, vol: 0.3,  type: 'sine' as OscillatorType },
      win:       { freq: 520, end: 820, dur: 0.16, vol: 0.5,  type: 'triangle' as OscillatorType },
      loss:      { freq: 320, end: 180, dur: 0.16, vol: 0.45, type: 'square' as OscillatorType },
    }[kind]

    osc.type = presets.type
    osc.frequency.setValueAtTime(presets.freq, now)
    osc.frequency.exponentialRampToValueAtTime(Math.max(80, presets.end), now + presets.dur)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(presets.vol, now + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + presets.dur)
    osc.start(now)
    osc.stop(now + presets.dur + 0.01)
  }, [ensureAudio])

  useEffect(() => {
    const unlock = () => { ensureAudio() }
    window.addEventListener('pointerdown', unlock, { passive: true })
    window.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [ensureAudio])

  // Internal: place a bet with explicit side and chip values.
  // Used by both the normal Bet button and the "Run it back" rebet flow.
  const placeBetWith = useCallback(async (side: 'pos' | 'neg', chip: number) => {
    if (!accessToken || !round) return
    if (countdown.lock <= 0) { playSfx('invalid'); showToast('Betting is closed', '#ff7c98'); return }
    if (balance !== null && chip > balance) { playSfx('invalid'); showToast('Insufficient balance', '#ff7c98'); return }
    sounds.bet()
    playSfx('confirm')
    setBetting(true)
    try {
      const res = await fetch('/api/bet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          round_id: round.id, side, amount: chip,
          idempotency_key: crypto.randomUUID(),
        }),
      })
      const json = await res.json()
      if (json.success) {
        showToast(`Bet placed · $${chip} on ${side === 'pos' ? '+PNL' : '−PNL'}`, '#7df2a8')
        setBalance(json.data.balance_usdc)
        lastBetRef.current = { side, amount: chip }
        refetch()
      } else {
        playSfx('invalid')
        showToast(json.error || 'Bet failed', '#ff7c98')
      }
    } catch {
      playSfx('invalid')
      showToast('Network error', '#ff7c98')
    } finally {
      setBetting(false)
    }
  }, [accessToken, round, countdown.lock, balance, playSfx, refetch])

  async function placeBet() {
    if (!selectedSide) { playSfx('invalid'); return showToast('Select a side first', '#ff7c98') }
    return placeBetWith(selectedSide, selectedChip)
  }

  // Fetch treasury wallet once on first mount so the deposit modal has it ready
  useEffect(() => {
    let cancelled = false
    fetch('/api/deposit')
      .then(r => r.json())
      .then(j => {
        if (cancelled) return
        setTreasuryWallet(j?.data?.treasury_wallet ?? null)
        setDepositTokenContract(j?.data?.token_contract ?? null)
        setTreasuryLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setTreasuryLoaded(true)
      })
    return () => { cancelled = true }
  }, [])

  function openDeposit() {
    playSfx('modalOpen')
    setDepositAmount('')
    setModal('deposit')
  }
  function openWithdraw() {
    playSfx('modalOpen')
    setWithdrawAmount('')
    // Prefill destination with the user's own wallet if available
    const w = user?.wallet?.address
    setWithdrawTo(w ?? '')
    setModal('withdraw')
  }
  function closeModal() {
    if (modalBusy) return
    playSfx('modalClose')
    setModal(null)
  }

  function dismissWelcome() {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(WELCOME_SEEN_KEY, '1')
    }
    playSfx('modalClose')
    setShowWelcome(false)
    if (typeof window !== 'undefined') {
      const done = window.localStorage.getItem(SPOTLIGHT_DONE_KEY) === '1'
      if (!done) {
        requestAnimationFrame(() => {
          setSpotlightStep(findNextAvailableStep(0))
        })
      }
    }
  }

  function finishSpotlight() {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SPOTLIGHT_DONE_KEY, '1')
    }
    setSpotlightStep(null)
  }

  function nextSpotlight() {
    if (spotlightStep === null) return finishSpotlight()
    const next = findNextAvailableStep(spotlightStep + 1)
    if (next === null) return finishSpotlight()
    setSpotlightStep(next)
  }

  useEffect(() => {
    if (spotlightStep === null || showWelcome || modal) return
    const updateRect = () => {
      const step = spotlightSteps[spotlightStep]
      const target = step ? getStepTarget(step.id) : null
      if (!target) return setSpotlightRect(null)
      setSpotlightRect(target.getBoundingClientRect())
    }
    updateRect()
    window.addEventListener('resize', updateRect)
    return () => window.removeEventListener('resize', updateRect)
  }, [getStepTarget, modal, showWelcome, spotlightStep, spotlightSteps])

  async function creditDeposit(txHash: string, amt: number) {
    if (!accessToken) return { ok: false as const, error: 'Missing auth' }
    const res = await fetch('/api/deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ tx_hash: txHash.trim(), amount: amt }),
    })
    const json = await res.json()
    if (!json.success) {
      return { ok: false as const, error: json.error || 'Deposit failed' }
    }
    return { ok: true as const, data: json.data as { amount_credited: number } }
  }

  async function submitDepositAuto() {
    if (!accessToken) return
    const amt = Number(depositAmount)
    if (!Number.isFinite(amt) || amt <= 0) {
      return showToast('Enter a valid amount', '#ff7c98')
    }
    if (!treasuryWallet || !depositTokenContract) {
      return showToast('Deposit route unavailable', '#ff7c98')
    }
    const fromWallet = user?.wallet?.address
    const eth = (window as typeof window & { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum
    if (!fromWallet || !eth) {
      return showToast('Wallet send unavailable on this device', '#ff7c98')
    }

    setModalBusy(true)
    showToast('Awaiting wallet confirmation…', '#9fd2ff')
    try {
      const txData = encodeFunctionData({
        abi: [{
          type: 'function',
          name: 'transfer',
          stateMutability: 'nonpayable',
          inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }],
          outputs: [{ name: '', type: 'bool' }],
        }],
        functionName: 'transfer',
        args: [treasuryWallet as `0x${string}`, parseUnits(String(amt), 6)],
      })

      const txHash = await eth.request({
        method: 'eth_sendTransaction',
        params: [{
          from: fromWallet,
          to: depositTokenContract,
          data: txData,
          value: '0x0',
          chainId: '0x2105', // Base mainnet
        }],
      }) as string

      if (!txHash?.startsWith('0x')) throw new Error('Wallet transaction failed')

      showToast('Verifying deposit…', '#9fd2ff')
      const credited = await creditDeposit(txHash, amt)
      if (!credited.ok) throw new Error(credited.error)

      playSfx('confirm')
      showToast(`Deposited $${fmt(credited.data.amount_credited)}`, '#7df2a8')
      fetchBalance()
      setModal(null)
    } catch (e) {
      playSfx('invalid')
      showToast(e instanceof Error ? e.message : 'Deposit failed', '#ff7c98')
    } finally {
      setModalBusy(false)
    }
  }

  function submitCustomChip() {
    const n = Math.floor(Number(customAmount))
    if (!Number.isFinite(n) || n <= 0) {
      playSfx('invalid')
      return showToast('Enter a valid amount', '#ff7c98')
    }
    const capped = balance !== null ? Math.min(n, Math.floor(balance)) : n
    if (capped <= 0) {
      playSfx('invalid')
      return showToast('Insufficient balance', '#ff7c98')
    }
    playSfx('chip')
    setSelectedChip(capped)
    setModal(null)
  }

  async function submitWithdraw() {
    if (!accessToken) return
    const amt = Number(withdrawAmount)
    if (!Number.isFinite(amt) || amt <= 0) {
      return showToast('Enter a valid amount', '#ff7c98')
    }
    if (!withdrawTo || !withdrawTo.startsWith('0x')) {
      return showToast('Enter a destination wallet', '#ff7c98')
    }
    if (balance !== null && amt > balance) {
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
        playSfx('confirm')
        showToast(`Withdrew $${fmt(json.data.amount)}`, '#7df2a8')
        // Refetch balance to get consistent available_usdc semantics
        fetchBalance()
        setModal(null)
      } else {
        playSfx('invalid')
        showToast(json.error || 'Withdraw failed', '#ff7c98')
      }
    } catch { playSfx('invalid'); showToast('Network error', '#ff7c98') }
    finally { setModalBusy(false) }
  }

  // Drive win/loss/void flash from `lastResult` (set by useRound) so it
  // fires even when /api/rounds/current has already swapped to the next round.
  useEffect(() => {
    if (!lastResult) return
    if (lastSettledIdRef.current === lastResult.round_id) return
    lastSettledIdRef.current = lastResult.round_id
    let t: ReturnType<typeof setTimeout> | undefined
    if (lastResult.outcome === 'win') {
      playSfx('win')
      setSettleFlash('win')
      t = setTimeout(() => setSettleFlash(null), 1300)
    } else if (lastResult.outcome === 'loss') {
      playSfx('loss')
      setSettleFlash('loss')
      t = setTimeout(() => setSettleFlash(null), 1300)
    } else if (lastResult.outcome === 'void') {
      showToast(
        lastResult.void_reason === 'one_sided_pool'
          ? 'Round voided — no opponent. Stake refunded.'
          : 'Round voided. Stake refunded.',
        '#9aa6c4'
      )
    }
    return () => { if (t) clearTimeout(t) }
  }, [lastResult, playSfx])

  useEffect(() => {
    let cancelled = false
    async function fetchRecent() {
      try {
        const res = await fetch('/api/rounds/history?limit=6')
        const json = await res.json()
        if (!cancelled) setRecentRounds(json?.data?.rounds ?? [])
      } catch {}
    }
    fetchRecent()
    const id = setInterval(fetchRecent, 12_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const isLocked = !round || round.status !== 'open' || countdown.lock <= 0
  const pnlPos   = (round?.pnl_usd ?? 0) >= 0

  const phase = !round ? 'loading'
    : round.status === 'open' && countdown.lock > 0 ? 'betting'
    : round.status === 'locked' || (round.status === 'open' && countdown.lock <= 0) ? 'watching'
    : round.status === 'settled' ? 'settled'
    : round.status === 'void' ? 'void'
    : 'loading'

  const roundRemainingMs = Math.max(0, countdown.close)
  const timerSec = Math.ceil(roundRemainingMs / 1000)

  // Final 10 seconds of betting → pulse + "LAST CALL"
  const isFinalCountdown = phase === 'betting' && countdown.lock > 0 && countdown.lock <= 10_000

  const timerDisplay = `0:${String(Math.max(0, timerSec)).padStart(2, '0')}`

  const { totalRoundMs, lockMarkerPct } = (() => {
    if (!round) return { totalRoundMs: 1, lockMarkerPct: 0 }
    const opens = new Date(round.open_price_ts).getTime()
    const lock = new Date(round.betting_closes_at).getTime()
    const closes = new Date(round.closes_at).getTime()
    if (!Number.isFinite(opens) || !Number.isFinite(lock) || !Number.isFinite(closes) || closes <= opens) {
      return { totalRoundMs: 1, lockMarkerPct: 0 }
    }
    const total = closes - opens
    const lockAtRemaining = Math.max(0, closes - lock)
    return {
      totalRoundMs: total,
      lockMarkerPct: (lockAtRemaining / total) * 100,
    }
  })()
  const progressPct = (roundRemainingMs / totalRoundMs) * 100

  const phaseLabel = phase === 'betting'
    ? (isFinalCountdown ? '● LAST CALL' : '● GET IN NOW')
    : phase === 'watching' ? '● MONEY IN MOTION'
    : phase === 'settled' ? '● RUN IT BACK'
    : phase === 'void' ? '● ROUND VOID'
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
    ? `${MVP_ASSET_LABEL} ${round.direction.toUpperCase()} · ${round.leverage}× · $${Math.round(round.position_size/1000)}k`
    : 'Loading...'

  // Price formatting for the context strip.
  function fmtPrice(n: number | undefined | null): string {
    if (n === undefined || n === null || !Number.isFinite(n)) return '---'
    const abs = Math.abs(n)
    const digits = abs >= 1 ? 2 : 4
    return '$' + n.toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
  }

  // Profit/loss amount on a settled bet
  const settleWon = myBet?.won === true
  const settleProfit = myBet
    ? (settleWon
        ? (Number(myBet.actual_winnings ?? myBet.estimated_winnings ?? myBet.amount) - Number(myBet.amount))
        : -Number(myBet.amount))
    : 0

  const cfmText = betting ? 'Placing...'
    : phase === 'watching' ? 'Waiting For Next Round'
    : phase === 'settled' ? 'Waiting For Next Round'
    : phase === 'void' ? 'Round Voided'
    : isLocked ? 'Betting Closed'
    : !selectedSide ? 'Select Side'
    : `${selectedSide === 'pos' ? '+PNL' : '−PNL'} · $${selectedChip} · Place Bet`

  const estimatedPayout = (() => {
    if (!round || !selectedSide) return null
    const winPool = selectedSide === 'pos' ? Number(round.pos_pool) : Number(round.neg_pool)
    const losePool = selectedSide === 'pos' ? Number(round.neg_pool) : Number(round.pos_pool)
    if (!Number.isFinite(winPool) || !Number.isFinite(losePool)) return null
    if (winPool <= 0) return selectedChip
    return selectedChip + (selectedChip / winPool) * (losePool * 0.95)
  })()
  const ctaSubtext = !selectedSide
    ? 'Choose +PNL or −PNL to preview payout'
    : estimatedPayout === null
      ? 'Live payout unavailable'
      : `Est. payout $${fmt(estimatedPayout)}`

  const totalPool = Number(round?.pos_pool ?? 0) + Number(round?.neg_pool ?? 0)
  const posShare = totalPool > 0 ? (Number(round?.pos_pool ?? 0) / totalPool) * 100 : 50
  const negShare = 100 - posShare
  const crowdLean = posShare === negShare ? 'Balanced' : posShare > negShare ? 'Crowd leaning +PNL' : 'Crowd leaning −PNL'
  const baseCrowdBias = posShare > 66
    ? 'Crowd heavy +PNL · contrarian edge on −PNL'
    : negShare > 66
      ? 'Crowd heavy −PNL · contrarian edge on +PNL'
      : 'Balanced market pressure'
  const crowdBiasNote = selectedSide === 'pos'
    ? `You’re against ${Math.round(negShare)}%`
    : selectedSide === 'neg'
      ? `You’re against ${Math.round(posShare)}%`
      : baseCrowdBias
  const recentSettled = recentRounds.filter(r => r.result === 'pos' || r.result === 'neg' || r.result === 'void')
  const lastSix = recentSettled.slice(0, 6)
  const posWins = lastSix.filter(r => r.result === 'pos').length
  const negWins = lastSix.filter(r => r.result === 'neg').length
  const streak = (() => {
    const first = recentSettled[0]?.result
    if (!first || first === 'void') return null
    let len = 1
    for (let i = 1; i < recentSettled.length; i++) {
      if (recentSettled[i].result !== first) break
      len += 1
    }
    return { side: first, len }
  })()
  const patternSignal = !lastSix.length
    ? 'Pattern loading'
    : streak && streak.len >= 4
      ? 'Contrarian chance building'
    : Math.abs(posWins - negWins) <= 1
      ? 'Market flipping'
      : posWins > negWins
        ? `+PNL won ${posWins}/${lastSix.length}`
        : `−PNL won ${negWins}/${lastSix.length}`
  const lastSettledLabel = recentSettled[0]?.settled_at
    ? `${Math.max(0, Math.round((Date.now() - new Date(recentSettled[0].settled_at as string).getTime()) / 1000))}s ago`
    : 'live'
  const payoutMultipleForRound = (r: HistoryRound) => {
    const pool = Number(r.pos_pool ?? 0) + Number(r.neg_pool ?? 0)
    const winnerPool = r.result === 'pos' ? Number(r.pos_pool ?? 0) : r.result === 'neg' ? Number(r.neg_pool ?? 0) : 0
    if (r.result === 'void' || winnerPool <= 0) return null
    return 1 + (pool * 0.95) / winnerPool
  }
  const latestSettle = recentSettled[0] ?? null
  const latestMult = latestSettle ? payoutMultipleForRound(latestSettle) : null
  const biggestRecentMult = recentSettled.reduce((mx, r) => {
    const mult = payoutMultipleForRound(r)
    return mult && mult > mx ? mult : mx
  }, 0)
  const proofLine = biggestRecentMult > 0 ? `Biggest recent payout ${biggestRecentMult.toFixed(2)}×` : 'Recent settles loading'
  const heroValue = `$${round ? Math.round(round.current_value).toLocaleString() : '---'}`
  const pnlText = `${pnlPos ? '+' : ''}$${Math.abs(round?.pnl_usd ?? 0).toFixed(2)}`

  useEffect(() => {
    const fitText = (
      textEl: HTMLElement | null,
      cardEl: HTMLElement | null,
      max: number,
      min: number,
      setter: (n: number) => void,
    ) => {
      if (!textEl || !cardEl) return
      const width = Math.max(0, cardEl.clientWidth - 18)
      let size = max
      textEl.style.fontSize = `${size}px`
      while (size > min && textEl.scrollWidth > width) {
        size -= 1
        textEl.style.fontSize = `${size}px`
      }
      setter(size)
    }

    const runFit = () => {
      fitText(heroTextRef.current, heroCardRef.current, 52, 18, setHeroFontPx)
      fitText(pnlTextRef.current, pnlCardRef.current, 15, 10, setPnlFontPx)
      fitText(timerTextRef.current, timerCardRef.current, 16, 11, setTimerFontPx)
    }

    runFit()
    const ro = new ResizeObserver(() => runFit())
    if (heroCardRef.current) ro.observe(heroCardRef.current)
    if (pnlCardRef.current) ro.observe(pnlCardRef.current)
    if (timerCardRef.current) ro.observe(timerCardRef.current)
    window.addEventListener('resize', runFit)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', runFit)
    }
  }, [heroValue, pnlText, timerDisplay])

  return (
    <div className="hl-root">
      <LiveTicker />

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
            <div className="tagline">
              <span className="tag-pos">+PNL</span>
              <span className="tag-or">or</span>
              <span className="tag-neg">−PNL</span>
              <span className="tag-in">in 30s</span>
            </div>
          </div>
          <SoundToggle />
          {!ready ? (
            <div className="isl account-isl skeleton-account" />
          ) : !authenticated ? (
            <button className="isl connect-pill" ref={(el) => { accountGuideRef.current = el }} onClick={() => { sounds.click(); login() }}>Connect</button>
          ) : (
            <div className="isl account-isl account-center" ref={(el) => { accountGuideRef.current = el }}>
              <button className="acct-btn deposit" onClick={() => { sounds.click(); openDeposit() }}>Deposit</button>
              <div className="acct-bal">
                <div className="bl">Available</div>
                <div className="bv">{balance !== null ? `$${fmt(balance)}` : '---'}</div>
              </div>
              <button className="acct-btn withdraw" onClick={() => { sounds.click(); openWithdraw() }}>Cash Out</button>
            </div>
          )}
          <div className="hdr-util-dot" aria-hidden />
        </div>

        <div className="stats-row">
          {/* ISLAND 1: Position Value */}
          <div className="isl val-isl" ref={heroCardRef}>
            <div className="vi-lbl">{posLabel}</div>
            <div ref={heroTextRef} className={`big-val ${pnlPos ? 'pos' : 'neg'}`} style={{ fontSize: `${heroFontPx}px` }}>
              {heroValue}
            </div>
          </div>

          {/* ISLAND 2: PnL */}
          <div className={`isl pnl-isl${pnlJuice ? ` juice-${pnlJuice}` : ''}`} ref={pnlCardRef}>
            <span className="pnl-mini">PnL</span>
            <span
              ref={pnlTextRef}
              className="pnl-chg"
              style={{ color: pnlPos ? '#7df2a8' : '#ff7c98', fontSize: `${pnlFontPx}px` }}
            >
              {pnlText}
            </span>
            <span className="pnl-pct">
              {pnlPos ? '+' : ''}{(round?.pnl_pct ?? 0).toFixed(2)}%
            </span>
            <span className="pnl-round">Round #{round?.round_number ?? '---'}</span>
          </div>

          {/* ISLAND 3: Timer */}
          <div className="isl timer-isl" ref={timerCardRef}>
            <div className="ti-row">
              <span
                className={`phase-lbl${isFinalCountdown ? ' locking-soon' : ''}`}
                style={{ color: phaseColor }}
              >
                {phaseLabel}
              </span>
              <span ref={timerTextRef} className={`timer-num${isFinalCountdown ? ' locking-soon' : ''}`} style={{ fontSize: `${timerFontPx}px` }}>
                {timerDisplay}
              </span>
            </div>
            <div className="prog-tr">
              <div className="prog-f" style={{ width: `${Math.max(0, Math.min(100, progressPct))}%`, background: progColor }} />
              <div className="prog-lock-marker" style={{ left: `${Math.max(0, Math.min(100, lockMarkerPct))}%` }} />
            </div>
          </div>
        </div>

        {/* CONTEXT STRIP: Entry / Now / Players Live */}
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
            <div className="ctx-lbl">Players Live</div>
            <div className={`ctx-val${isFinalCountdown ? ' locking-soon' : ''}`}>
              {round ? Math.round((Number(round.pos_pool) + Number(round.neg_pool)) / 12) : '--'}
            </div>
          </div>
        </div>
        <div className="isl split-isl">
          <div className="split-head">
            <span>Market Split</span>
            <span>{crowdLean}</span>
          </div>
          <div className="split-track">
            <div className="split-pos" style={{ width: `${Math.max(0, posShare)}%` }} />
            <div className="split-neg" style={{ width: `${Math.max(0, negShare)}%` }} />
          </div>
          <div className="split-meta">
            <span>+PNL {posShare.toFixed(0)}%</span>
            <span>−PNL {negShare.toFixed(0)}%</span>
          </div>
          <div className="split-note">{crowdBiasNote}</div>
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
            <div className="isl chips-isl" ref={chipsGuideRef}>
              <div className="ci-lbl">1 · Select Amount</div>
              <div className="chips-row">
                {CHIPS.map(c => (
                  <div key={c} className={`chip${selectedChip === c ? ' sel' : ''}`} onClick={() => { playSfx('chip'); setSelectedChip(c) }}>
                    ${c}
                  </div>
                ))}
                <div className="chip" style={{ fontSize: 9 }} onClick={() => {
                  playSfx('modalOpen')
                  setCustomAmount(String(selectedChip))
                  setModal('custom')
                }}>
                  CUSTOM
                </div>
              </div>
            </div>

            {/* ISLANDS 5a & 5b */}
            <div className="btns-row" ref={sidesGuideRef}>
              <button
                className={`sb sb-pos${selectedSide === 'pos' ? ' on' : ''}${isLocked ? ' sb-locked' : ''}`}
                onClick={() => {
                  if (isLocked) return playSfx('invalid')
                  playSfx('side')
                  setSelectedSide(prev => prev === 'pos' ? null : 'pos')
                }}
              >+PNL</button>
              <button
                className={`sb sb-neg${selectedSide === 'neg' ? ' on' : ''}${isLocked ? ' sb-locked' : ''}`}
                onClick={() => {
                  if (isLocked) return playSfx('invalid')
                  playSfx('side')
                  setSelectedSide(prev => prev === 'neg' ? null : 'neg')
                }}
              >−PNL</button>
            </div>

            {/* ISLAND 6: Confirm */}
            <button
              ref={confirmGuideRef}
              className={`cfm-isl${selectedSide && !isLocked ? ' rdy' : ''}`}
              disabled={betting}
              onClick={placeBet}
            >
              <span className="cfm-main">{cfmText}</span>
              <span className="cfm-sub">{ctaSubtext}</span>
            </button>
          </>
        )}

        <div className="isl history-isl">
          <div className="history-hdr">
            <span>Market Activity</span>
            <span className="history-dot">Recent Settles</span>
          </div>
          <div className="history-meta">
            <span className={`streak-tag ${streak?.side === 'pos' ? 'pos' : streak?.side === 'neg' ? 'neg' : ''}`}>
              {streak ? `${streak.side === 'pos' ? '+PNL' : '−PNL'} streak ×${streak.len}` : 'No active streak'}
            </span>
            <span className="settled-tag">Last settle {lastSettledLabel}</span>
          </div>
          {latestSettle && (
            <div className={`result-hit ${latestSettle.result === 'pos' ? 'pos' : latestSettle.result === 'neg' ? 'neg' : 'void'}`}>
              <div className="rh-left">
                <div className="rh-main">{latestSettle.result === 'pos' ? '+PNL WON' : latestSettle.result === 'neg' ? '−PNL WON' : 'VOID ROUND'}</div>
                <div className="rh-sub">
                  R{latestSettle.round_number} · Pool ${Math.round((Number(latestSettle.pos_pool ?? 0) + Number(latestSettle.neg_pool ?? 0))).toLocaleString()}
                </div>
              </div>
              <div className="rh-chip">
                {latestMult ? `${latestMult.toFixed(2)}× PAID` : 'VOID'}
              </div>
            </div>
          )}
          <div className="history-pattern">{patternSignal}</div>
          <div className="history-proof">{proofLine}</div>
          <div className="history-tape">
            {(recentRounds.length ? recentRounds : [{ round_number: 0, result: null, pnl_pct: null, settled_at: null }]).map((r, i) => {
              const result = r.result === 'void' ? 'VOID' : r.result === 'pos' ? '+PNL' : r.result === 'neg' ? '−PNL' : '—'
              const resultClass = r.result === 'void' ? 'void' : r.result === 'pos' ? 'pos' : r.result === 'neg' ? 'neg' : ''
              const pool = Number(r.pos_pool ?? 0) + Number(r.neg_pool ?? 0)
              const mult = payoutMultipleForRound(r)
              return (
                <div className={`history-pill ${resultClass}`} key={`${r.round_number}-${i}`}>
                  <span className="hr-round">{r.round_number ? `R${r.round_number}` : 'Soon'}</span>
                  <span className="hr-side">{result} {mult ? `${mult.toFixed(2)}×` : ''}</span>
                  <span className="hr-meta">
                    {r.pnl_pct !== null ? `${r.pnl_pct > 0 ? '+' : ''}${r.pnl_pct.toFixed(1)}%` : 'Pending'}
                    {pool > 0 ? ` · $${Math.round(pool)}` : ''}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
        </div>
      </div>

      {/* ── FIRST-VISIT WELCOME MODAL ── */}
      {showWelcome && domReady && createPortal(
        <div className="modal-backdrop welcome-backdrop" onClick={dismissWelcome}>
          <div className="modal-card welcome-card" onClick={(e) => e.stopPropagation()}>
            <div className="welcome-kicker">Welcome to HolyLiquid</div>
            <div className="welcome-title">Bet whether the live leveraged ETH position closes +PNL or −PNL</div>
            <div className="welcome-steps">
              <div className="welcome-step"><span>1</span>Pick your amount</div>
              <div className="welcome-step"><span>2</span>Choose +PNL or −PNL before lock</div>
              <div className="welcome-step"><span>3</span>Win when the leveraged position settles</div>
            </div>
            <div className="welcome-notes">
              <span>Live ETH price</span>
              <span>USDC on Base</span>
              <span>Cash out anytime</span>
            </div>
            <div className="welcome-ctas">
              <button className="welcome-btn primary" onClick={dismissWelcome}>Start Playing</button>
              <button className="welcome-btn ghost" onClick={dismissWelcome}>Watch a Round First</button>
            </div>
          </div>
        </div>
      , document.body)}

      {/* ── QUICK SPOTLIGHT GUIDE ── */}
      {spotlightStep !== null && !showWelcome && !modal && domReady && createPortal(
        <div className="spotlight-overlay">
          {spotlightRect && (
            <>
              <div
                className="spotlight-ring"
                style={{
                  left: spotlightRect.left - 8,
                  top: spotlightRect.top - 8,
                  width: spotlightRect.width + 16,
                  height: spotlightRect.height + 16,
                }}
              />
              <div
                className="spotlight-arrow"
                style={{
                  left: spotlightRect.left + spotlightRect.width / 2 - 10,
                  top: Math.max(10, spotlightRect.top - 26),
                }}
              />
            </>
          )}
          <div className="spotlight-card">
            <div className="spotlight-step">Quick Guide · {spotlightStep + 1}/{spotlightSteps.length}</div>
            <div className="spotlight-title">{spotlightSteps[spotlightStep]?.title}</div>
            <div className="spotlight-text">{spotlightSteps[spotlightStep]?.text}</div>
            <div className="spotlight-actions">
              <button className="spotlight-btn ghost" onClick={finishSpotlight}>Skip</button>
              <button className="spotlight-btn primary" onClick={nextSpotlight}>
                {spotlightStep >= spotlightSteps.length - 1 ? 'Done' : 'Next'}
              </button>
            </div>
          </div>
        </div>
      , document.body)}

      {/* ── DEPOSIT / WITHDRAW MODAL ── */}
      {modal && domReady && createPortal(
        <div className="modal-backdrop" onClick={closeModal}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            {modal === 'deposit' && (
              <>
                <div className="modal-title">Deposit USDC</div>
                <div className="modal-sub">
                  Deposit USDC on <strong>Base</strong> in one tap. Confirm the transfer in your wallet and we&apos;ll credit your balance automatically.
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
                <div className="modal-btns">
                  <button
                    className="mb submit"
                    style={{ width: '100%' }}
                    disabled={modalBusy || !treasuryWallet}
                    onClick={submitDepositAuto}
                  >
                    {modalBusy ? 'Depositing…' : 'Deposit Now'}
                  </button>
                </div>
                <div className="modal-btns">
                  <button className="mb cancel" disabled={modalBusy} onClick={closeModal}>Cancel</button>
                </div>
              </>
            )}

            {modal === 'custom' && (
              <>
                <div className="modal-title">Custom Bet Amount</div>
                <div className="modal-sub">
                  Enter any amount in whole dollars. We&apos;ll clamp it to your available balance if needed.
                </div>
                <div className="modal-field">
                  <label>Amount (USD)</label>
                  <input
                    className="modal-input"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    step="1"
                    placeholder="7"
                    value={customAmount}
                    onChange={(e) => setCustomAmount(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitCustomChip() }}
                    autoFocus
                  />
                </div>
                {balance !== null && (
                  <div className="modal-sub" style={{ textAlign: 'right' }}>
                    Available: <strong style={{ color: '#7df2a8' }}>${fmt(balance)}</strong>
                  </div>
                )}
                <div className="modal-btns">
                  <button className="mb cancel" onClick={closeModal}>Cancel</button>
                  <button className="mb submit" onClick={submitCustomChip}>Set Amount</button>
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
                {(() => {
                  const amt = Number(withdrawAmount) || 0
                  const fee = Math.round(amt * 0.03 * 100) / 100
                  const net = Math.round((amt - fee) * 100) / 100
                  if (amt <= 0) return null
                  return (
                    <div className="withdraw-preview">
                      <div className="wp-row">
                        <span className="wp-label">You receive</span>
                        <span className="wp-value wp-value--green">${net.toFixed(2)}</span>
                      </div>
                      <div className="wp-row">
                        <span className="wp-label">Platform fee (3%)</span>
                        <span className="wp-value">−${fee.toFixed(2)}</span>
                      </div>
                    </div>
                  )
                })()}
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
      , document.body)}

      {/* TOAST */}
      {toast && (
        <div className="hl-toast" style={{ color: toast.color, borderColor: toast.color + '44' }}>
          {toast.msg}
        </div>
      )}

      <LastResultBanner
        result={(() => {
          if (!lastResult) return null
          // Map user-level outcome (win/loss/void) onto the banner's vocabulary.
          // - wins always show the celebratory +PNL variant
          // - losses show LIQUIDATED (dramatic red) when the round liquidated, else -PNL
          // - void rounds show VOID
          if (lastResult.outcome === 'void') {
            return { outcome: 'VOID' as const, winnings: 0, pnlPct: 0 }
          }
          if (lastResult.outcome === 'win') {
            const profit = lastResult.winnings - lastResult.bet_amount
            const pnlPct = lastResult.bet_amount > 0 ? (profit / lastResult.bet_amount) * 100 : 0
            return { outcome: '+PNL' as const, winnings: lastResult.winnings, pnlPct }
          }
          // outcome === 'loss'
          const isLiq = lastResult.result_label === 'LIQUIDATED'
          return {
            outcome: isLiq ? ('LIQUIDATED' as const) : ('-PNL' as const),
            winnings: 0,
            pnlPct: -100,
          }
        })()}
        lastBetAmount={lastBetRef.current?.amount ?? lastResult?.bet_amount ?? null}
        onRebet={(side, amount) => {
          if (!round || round.status !== 'open') {
            showToast('Wait for next round to open', '#9aa6c4')
            return
          }
          placeBetWith(side, amount)
        }}
        onDismiss={clearLastResult}
      />
    </div>
  )
}
