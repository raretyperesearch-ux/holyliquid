import { Round, RoundResult, PriceData } from './types'
import { db } from './db'
import { broadcast } from './broadcast'
import { voidRound } from './void'
import { trackLpSettlement } from './lp'
import { trackBotSettlement } from './bots'

const PLATFORM_FEE = 0.07

export function calculateResult(position: Round, openPrice: number, closePrice: number): RoundResult {
  const priceChange = (closePrice - openPrice) / openPrice
  const dirMult     = position.direction === 'long' ? 1 : -1
  const pnlUsd      = position.position_size * priceChange * dirMult
  const pnlPct      = priceChange * position.leverage * dirMult * 100

  const liquidated = position.direction === 'long'
    ? closePrice <= position.liq_price
    : closePrice >= position.liq_price

  return {
    pnlUsd,
    pnlPct,
    outcome:     liquidated ? 'LIQUIDATED' : pnlUsd > 0 ? '+PNL' : '-PNL',
    winningSide: (liquidated || pnlUsd <= 0) ? 'neg' : 'pos',
  }
}

export async function settleRound(
  round: Round,
  closePrice: PriceData,
  result: RoundResult
): Promise<void> {
  // Idempotency check
  const current = await db.rounds.get(round.id)
  if (current.status === 'settled' || current.status === 'void') {
    console.log(`[Settle] Round #${round.round_number} already ${current.status}, skipping`)
    return
  }

  // ── Void guard: one-sided rounds ──────────────────────────────
  // If either side has zero stake, there's no real opposing trade.
  // Refund every bet via voidRound() instead of pretending someone "won".
  // Prevents the misleading state where solo players see outcome='win'
  // but no profit added to their balance.
  const posPool = Number(round.pos_pool) || 0
  const negPool = Number(round.neg_pool) || 0
  if (posPool === 0 || negPool === 0) {
    console.log(`[Settle] Round #${round.round_number} one-sided (pos=$${posPool}, neg=$${negPool}) — voiding`)
    await voidRound(round.id, 'one_sided_pool')
    return
  }

  const bets        = await db.bets.getForRound(round.id)
  const winningBets = bets.filter(b => b.side === result.winningSide)
  const losingBets  = bets.filter(b => b.side !== result.winningSide)

  const winningPool     = result.winningSide === 'pos' ? posPool : negPool
  const totalPool       = posPool + negPool
  const fee             = totalPool * PLATFORM_FEE
  const distributable   = totalPool - fee
  const prize           = distributable - winningPool  // what's left after returning winning stakes

  const payouts = winningBets.map(bet => ({
    ...bet,
    winnings: bet.amount + (winningPool > 0 ? (bet.amount / winningPool) * prize : 0),
  }))

  // Process losses
  for (const bet of losingBets) {
    await db.bets.update(bet.id, { won: false, outcome: 'loss', winnings: 0 })
    await db.balances.decreaseLocked(bet.wallet, bet.amount)
    await db.transactions.insert({
      wallet: bet.wallet, type: 'bet', amount: bet.amount,
      round_id: round.id, bet_id: bet.id, note: 'loss',
    })
    // Track LP/bot losses for daily cap
    trackLpSettlement(bet.wallet, false, bet.amount)
    trackBotSettlement(bet.wallet, false, bet.amount)
  }

  // Process wins
  for (const bet of payouts) {
    await db.bets.update(bet.id, { won: true, outcome: 'win', winnings: bet.winnings })
    await db.balances.decreaseLocked(bet.wallet, bet.amount)
    await db.balances.increase(bet.wallet, bet.winnings)
    await db.transactions.insert({
      wallet: bet.wallet, type: 'payout', amount: bet.winnings,
      round_id: round.id, bet_id: bet.id,
      note: `win: $${bet.winnings.toFixed(2)} on $${bet.amount} bet`,
    })
    trackLpSettlement(bet.wallet, true, bet.amount)
    trackBotSettlement(bet.wallet, true, bet.amount)
  }

  // Platform fee
  if (fee > 0) {
    await db.transactions.insert({
      wallet: 'platform', type: 'fee', amount: fee, round_id: round.id,
    })
  }

  // ── Update round status LAST so all bets are settled before any client sees status='settled' ──
  // This prevents a race where the frontend sees a settled round with unmarked bet outcomes,
  // which used to cause winners to briefly see "You Lost" before flipping to "You Won".
  await db.rounds.update(round.id, {
    status:         'settled',
    close_price:    closePrice.price,
    close_price_ts: new Date(closePrice.timestamp),
    result:         result.outcome,
    pnl_usd:        result.pnlUsd,
    pnl_pct:        result.pnlPct,
    fee_collected:  fee,
    settled_at:     new Date(),
  })

  await broadcast.roundResult(round.id, result, closePrice.price, posPool, negPool, fee)
  console.log(`[Settle] Round #${round.round_number} settled: ${result.outcome} | PnL: $${result.pnlUsd.toFixed(2)}`)
}
