import { Round, RoundResult, PriceData } from './types'
import { db } from './db'
import { broadcast } from './broadcast'

const PLATFORM_FEE = 0.05

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
  if (current.status === 'settled') {
    console.log(`[Settle] Round #${round.round_number} already settled, skipping`)
    return
  }

  const bets        = await db.bets.getForRound(round.id)
  const winningBets = bets.filter(b => b.side === result.winningSide)
  const losingBets  = bets.filter(b => b.side !== result.winningSide)

  const losingPool  = result.winningSide === 'pos' ? round.neg_pool : round.pos_pool
  const winningPool = result.winningSide === 'pos' ? round.pos_pool : round.neg_pool
  const fee         = losingPool * PLATFORM_FEE
  const prize       = losingPool * (1 - PLATFORM_FEE)

  const payouts = winningBets.map(bet => ({
    ...bet,
    winnings: bet.amount + (winningPool > 0 ? (bet.amount / winningPool) * prize : 0),
  }))

  // Atomic: update round + all bets + all balances
  const supabase = (await import('./db')).getSupabaseClient()

  // Update round status
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

  // Process losses
  for (const bet of losingBets) {
    await db.bets.update(bet.id, { won: false, outcome: 'loss', winnings: 0 })
    await db.balances.decreaseLocked(bet.wallet, bet.amount)
    await db.transactions.insert({
      wallet: bet.wallet, type: 'bet', amount: bet.amount,
      round_id: round.id, bet_id: bet.id, note: 'loss',
    })
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
  }

  // Platform fee
  if (fee > 0) {
    await db.transactions.insert({
      wallet: 'platform', type: 'fee', amount: fee, round_id: round.id,
    })
  }

  await broadcast.roundResult(round.id, result, closePrice.price, round.pos_pool, round.neg_pool, fee)
  console.log(`[Settle] Round #${round.round_number} settled: ${result.outcome} | PnL: $${result.pnlUsd.toFixed(2)}`)
}
