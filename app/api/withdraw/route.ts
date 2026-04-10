import { NextRequest } from 'next/server'
import { verifyAuth, unauthorized, ok, badRequest, serverError } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase/server'
import { sendUsdc } from '@/lib/withdraw'

const MIN_WITHDRAW = 1
const MAX_WITHDRAW = 10_000

export async function POST(req: NextRequest) {
  try {
    const wallet = await verifyAuth(req)
    const body = await req.json()
    const { amount, to_wallet } = body

    if (!amount || amount < MIN_WITHDRAW) return badRequest(`Minimum withdrawal is $${MIN_WITHDRAW}`)
    if (amount > MAX_WITHDRAW) return badRequest(`Maximum withdrawal is $${MAX_WITHDRAW}`)
    if (!to_wallet) return badRequest('to_wallet required')

    const sb = createServerSupabase()

    // Check available balance (balance - locked)
    const { data: bal, error: balError } = await sb
      .from('hl_balances')
      .select('balance_usdc, locked_usdc')
      .eq('wallet', wallet)
      .single()

    if (balError) return badRequest('No balance found')

    const available = Number(bal.balance_usdc) - Number(bal.locked_usdc)
    if (available < amount) {
      return badRequest(`Insufficient available balance. Available: $${available.toFixed(2)}`)
    }

    // ⚠️ AUDIT BEFORE PRODUCTION ⚠️
    // The block below has two semantic issues worth a second pair of eyes
    // before real-money traffic:
    //
    // 1. The `hl_decrease_locked(p_amount: 0)` call is a no-op placeholder
    //    that ignores its own `deductError`. It reads like something that
    //    was supposed to clear a lock but currently doesn't.
    //
    // 2. The balance update uses a non-atomic read-then-write pattern
    //    (`bal.balance_usdc - amount`) which isn't concurrency-safe under
    //    parallel withdraws. The `.gte('balance_usdc', amount)` guard
    //    prevents negative balances but can still race with other mutators.
    //    Prefer an atomic decrement RPC similar to `hl_credit_deposit`.
    //
    // Leaving intact so behavior doesn't change silently — flag for review.
    const { error: deductError } = await sb.rpc('hl_decrease_locked', {
      p_wallet: wallet,
      p_amount: 0, // no locked amount to decrease — placeholder, see note above
    })
    void deductError // intentionally swallowed; see audit note above

    // Direct balance deduction (see audit note re: atomicity)
    const { error: updateError } = await sb
      .from('hl_balances')
      .update({
        balance_usdc: Number(bal.balance_usdc) - amount,
        updated_at: new Date().toISOString(),
      })
      .eq('wallet', wallet)
      .gte('balance_usdc', amount) // guard condition

    if (updateError) throw updateError

    // Send USDC on-chain
    let txHash: string
    try {
      txHash = await sendUsdc(to_wallet, amount)
    } catch (e: any) {
      // Refund if tx fails
      await sb
        .from('hl_balances')
        .update({ balance_usdc: Number(bal.balance_usdc) })
        .eq('wallet', wallet)
      throw new Error(`On-chain transfer failed: ${e.message}`)
    }

    // Record transaction
    await sb.from('hl_transactions').insert({
      wallet,
      type: 'withdraw',
      amount,
      tx_hash: txHash,
      note: `withdrawal to ${to_wallet}`,
    })

    const newBalance = Number(bal.balance_usdc) - amount

    return ok({
      tx_hash: txHash,
      amount,
      balance_usdc: newBalance,
    })
  } catch (e: any) {
    if (e.message?.includes('token') || e.message?.includes('wallet')) {
      return unauthorized(e.message)
    }
    return serverError(e)
  }
}
