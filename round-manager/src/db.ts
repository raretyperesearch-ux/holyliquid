import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { Round, Bet } from './types'

let sb: SupabaseClient

export function connectSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY')
  sb = createClient(url, key)
  return sb
}

export function getSupabaseClient() {
  if (!sb) throw new Error('Supabase not connected')
  return sb
}

export const db = {
  rounds: {
    async insert(data: Omit<Round, 'id' | 'version' | 'created_at'>): Promise<Round> {
      const { data: row, error } = await sb
        .from('hl_rounds')
        .insert({
          round_number:      data.round_number,
          pair:              data.pair,
          direction:         data.direction,
          position_size:     data.position_size,
          leverage:          data.leverage,
          open_price:        data.open_price,
          open_price_ts:     data.open_price_ts,
          liq_price:         data.liq_price,
          status:            data.status,
          round_seed:        data.round_seed,
          betting_closes_at: data.betting_closes_at,
          closes_at:         data.closes_at,
          opened_at:         data.opened_at,
        })
        .select()
        .single()
      if (error) throw error
      return row as Round
    },

    async update(id: string, data: Partial<Round>): Promise<void> {
      const { error } = await sb.from('hl_rounds').update(data).eq('id', id)
      if (error) throw error
    },

    async get(id: string): Promise<Round> {
      const { data, error } = await sb.from('hl_rounds').select('*').eq('id', id).single()
      if (error) throw error
      return data as Round
    },

    async getPools(id: string): Promise<{ pos_pool: number; neg_pool: number }> {
      const { data, error } = await sb
        .from('hl_rounds')
        .select('pos_pool, neg_pool')
        .eq('id', id)
        .single()
      if (error) throw error
      return data
    },

    async findByStatus(statuses: string[]): Promise<Round[]> {
      const { data, error } = await sb
        .from('hl_rounds')
        .select('*')
        .in('status', statuses)
        .order('created_at', { ascending: true })
      if (error) throw error
      return (data || []) as Round[]
    },

    async getNextRoundNumber(): Promise<number> {
      const { data, error } = await sb
        .from('hl_rounds')
        .select('round_number')
        .order('round_number', { ascending: false })
        .limit(1)
        .single()
      if (error && error.code !== 'PGRST116') throw error
      return (data?.round_number ?? 0) + 1
    },
  },

  bets: {
    async getForRound(roundId: string): Promise<Bet[]> {
      const { data, error } = await sb
        .from('hl_bets')
        .select('*')
        .eq('round_id', roundId)
      if (error) throw error
      return (data || []) as Bet[]
    },

    async update(id: string, data: Partial<Bet>): Promise<void> {
      const { error } = await sb.from('hl_bets').update(data).eq('id', id)
      if (error) throw error
    },
  },

  balances: {
    async decreaseLocked(wallet: string, amount: number): Promise<void> {
      const { error } = await sb.rpc('hl_decrease_locked', { p_wallet: wallet, p_amount: amount })
      if (error) throw error
    },

    async increase(wallet: string, amount: number): Promise<void> {
      const { error } = await sb.rpc('hl_increase_balance', { p_wallet: wallet, p_amount: amount })
      if (error) throw error
    },
  },

  transactions: {
    async insert(data: {
      wallet: string
      type: string
      amount: number
      round_id?: string
      bet_id?: string
      note?: string
    }): Promise<void> {
      const { error } = await sb.from('hl_transactions').insert(data)
      if (error) throw error
    },
  },

  priceTicks: {
    async insert(roundId: string, price: number): Promise<void> {
      const { error } = await sb.from('hl_price_ticks').insert({
        round_id: roundId,
        price,
        ts: new Date().toISOString(),
      })
      if (error) console.warn('[Ticks] Insert failed:', error.message)
    },
  },
}
