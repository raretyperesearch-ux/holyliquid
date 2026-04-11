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

    // Fetch temp_name. Wrapped so the balance endpoint still works if the
    // hl_get_temp_name RPC hasn't been deployed yet.
    let temp_name: string | null = null
    try {
      const { data: nameData } = await sb.rpc('hl_get_temp_name', { p_wallet: wallet })
      temp_name = (nameData as string | null) ?? null
    } catch (e) {
      console.warn('[BALANCE] hl_get_temp_name failed (RPC may not exist yet):', e)
    }

    return ok({ wallet, balance_usdc, locked_usdc, available_usdc, temp_name })
  } catch (e: any) {
    if (e.message?.includes('token') || e.message?.includes('wallet')) {
      return unauthorized(e.message)
    }
    return serverError(e)
  }
}
