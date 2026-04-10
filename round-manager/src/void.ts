import { db } from './db'
import { broadcast } from './broadcast'

export async function voidRound(roundId: string, reason: string): Promise<void> {
  const current = await db.rounds.get(roundId)
  if (['settled', 'void'].includes(current.status)) return

  const bets = await db.bets.getForRound(roundId)

  await db.rounds.update(roundId, {
    status:     'void',
    void_reason: reason,
    voided_at:   new Date(),
  })

  for (const bet of bets) {
    await db.bets.update(bet.id, { outcome: 'void', won: false })
    await db.balances.decreaseLocked(bet.wallet, bet.amount)
    await db.balances.increase(bet.wallet, bet.amount)
    await db.transactions.insert({
      wallet:   bet.wallet,
      type:     'refund',
      amount:   bet.amount,
      round_id: roundId,
      bet_id:   bet.id,
      note:     `void: ${reason}`,
    })
  }

  await broadcast.roundState({ id: roundId, status: 'void', void_reason: reason } as any)
  console.log(`[Void] Round ${roundId} voided: ${reason} | refunded ${bets.length} bets`)
}
