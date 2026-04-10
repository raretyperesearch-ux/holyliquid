import { NextRequest } from 'next/server'
import { verifyAuth, unauthorized, ok, serverError } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase/server'

export async function GET(req: NextRequest) {
  try {
    const wallet = await verifyAuth(req)
    const sb = createServerSupabase()

    const { data, error } = await sb
      .from('hl_balances')
      .select('balance_usdc, locked_usdc')
      .eq('wallet', wallet)
      .single()

    if (error && error.code !== 'PGRST116') throw error

    const balance_usdc  = Number(data?.balance_usdc ?? 0)
    const locked_usdc   = Number(data?.locked_usdc ?? 0)
    const available_usdc = balance_usdc - locked_usdc

    return ok({ wallet, balance_usdc, locked_usdc, available_usdc })
  } catch (e: any) {
    if (e.message?.includes('token') || e.message?.includes('wallet')) {
      return unauthorized(e.message)
    }
    return serverError(e)
  }
}
