import { getSupabaseClient } from './db'
import { Round, RoundResult } from './types'

const CHANNEL = 'holyliquid:rounds'

export const broadcast = {
  async roundState(round: Partial<Round>): Promise<void> {
    try {
      const sb = getSupabaseClient()
      await sb.channel(CHANNEL).httpSend('round_state', {
        type:              'round_state',
        round_id:          round.id,
        round_number:      round.round_number,
        version:           round.version,
        status:            round.status,
        pair:              round.pair,
        direction:         round.direction,
        leverage:          round.leverage,
        position_size:     round.position_size,
        liq_price:         round.liq_price,
        open_price:        round.open_price,
        pos_pool:          round.pos_pool,
        neg_pool:          round.neg_pool,
        betting_closes_at: round.betting_closes_at,
        closes_at:         round.closes_at,
        round_seed:        round.round_seed,
        void_reason:       round.void_reason,
      })
    } catch (e) {
      console.warn('[Broadcast] roundState failed:', e)
    }
  },

  async priceTick(round: Round, currentPrice: number): Promise<void> {
    try {
      const sb = getSupabaseClient()
      const now = Date.now()
      const msUntilLock  = Math.max(0, new Date(round.betting_closes_at).getTime() - now)
      const msUntilClose = Math.max(0, new Date(round.closes_at).getTime() - now)
      const priceDelta   = currentPrice - round.open_price
      const pnlMult      = round.direction === 'long' ? 1 : -1
      const pnlUsd       = round.position_size * (priceDelta / round.open_price) * pnlMult
      const currentValue = round.position_size + pnlUsd

      await sb.channel(CHANNEL).httpSend('price_tick', {
        type:          'price_tick',
        round_id:      round.id,
        version:       round.version,
        current_price: currentPrice,
        current_value: currentValue,
        pnl_usd:       pnlUsd,
        pnl_pct:       (priceDelta / round.open_price) * round.leverage * pnlMult * 100,
        ms_until_lock:  msUntilLock,
        ms_until_close: msUntilClose,
      })
    } catch (e) {
      console.warn('[Broadcast] priceTick failed:', e)
    }
  },

  async roundResult(
    roundId: string,
    result: RoundResult,
    closePrice: number,
    posPool: number,
    negPool: number,
    fee: number
  ): Promise<void> {
    try {
      const sb = getSupabaseClient()
      await sb.channel(CHANNEL).httpSend('round_result', {
        type:         'round_result',
        round_id:     roundId,
        result:       result.outcome,
        winning_side: result.winningSide,
        close_price:  closePrice,
        pnl_usd:      result.pnlUsd,
        pnl_pct:      result.pnlPct,
        pos_pool:     posPool,
        neg_pool:     negPool,
        fee,
      })
    } catch (e) {
      console.warn('[Broadcast] roundResult failed:', e)
    }
  },
}
