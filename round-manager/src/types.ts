export type Pair = 'ETH/USD' | 'BTC/USD' | 'SOL/USD'
export type Direction = 'long' | 'short'
export type RoundStatus = 'pending' | 'open' | 'locked' | 'settling' | 'settled' | 'void'
export type BetSide = 'pos' | 'neg'
export type BetOutcome = 'win' | 'loss' | 'void'

export interface Position {
  pair: Pair
  direction: Direction
  size: number
  leverage: 50 | 75 | 100
}

export interface PriceData {
  pair: string
  price: number
  timestamp: number  // unix ms
}

export interface Round {
  id: string
  round_number: number
  version: number
  pair: Pair
  direction: Direction
  position_size: number
  leverage: number
  open_price: number
  open_price_ts: Date
  liq_price: number
  close_price?: number
  close_price_ts?: Date
  result?: string
  pnl_usd?: number
  pnl_pct?: number
  pos_pool: number
  neg_pool: number
  fee_collected: number
  status: RoundStatus
  void_reason?: string
  round_seed: string
  betting_closes_at: Date
  closes_at: Date
  opened_at: Date
  locked_at?: Date
  settled_at?: Date
  voided_at?: Date
  created_at: Date
}

export interface Bet {
  id: string
  idempotency_key: string
  round_id: string
  wallet: string
  side: BetSide
  amount: number
  winnings?: number
  won?: boolean
  outcome?: BetOutcome
  created_at: Date
}

export interface RoundResult {
  pnlUsd: number
  pnlPct: number
  outcome: '+PNL' | '-PNL' | 'LIQUIDATED'
  winningSide: BetSide
}
