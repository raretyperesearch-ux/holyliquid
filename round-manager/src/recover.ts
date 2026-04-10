import { db } from './db'
import { fetchFreshPrice } from './oracle'
import { calculateResult, settleRound } from './settle'
import { voidRound } from './void'

export async function resolveOrphanedRounds(): Promise<void> {
  const orphans = await db.rounds.findByStatus(['open', 'locked', 'settling'])

  if (orphans.length === 0) {
    console.log('[Recover] No orphaned rounds found')
    return
  }

  console.log(`[Recover] Found ${orphans.length} orphaned round(s)`)

  for (const round of orphans) {
    const now = Date.now()
    const closesAt = new Date(round.closes_at).getTime()

    if (closesAt < now) {
      console.log(`[Recover] Round #${round.round_number} is overdue — attempting settlement`)
      const closePrice = await fetchFreshPrice(round.pair)
      if (closePrice) {
        const result = calculateResult(round, round.open_price, closePrice.price)
        await settleRound(round, closePrice, result)
      } else {
        await voidRound(round.id, 'orphan_stale_price')
      }
    } else {
      console.log(`[Recover] Round #${round.round_number} still has time — voiding for safety`)
      await voidRound(round.id, 'crash_recovery')
    }
  }
}
