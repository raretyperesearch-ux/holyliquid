import { NextRequest } from 'next/server'
import { verifyAuth, unauthorized, ok, badRequest, serverError } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase/server'
import { sendUsdc } from '@/lib/withdraw'

const MIN_WITHDRAW = 1
const MAX_WITHDRAW = 10_000
const WITHDRAW_FEE_RATE = 0.03  // 3% withdrawal fee

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

    // Calculate fee and net amount sent on-chain
    const fee = Math.round(amount * WITHDRAW_FEE_RATE * 100) / 100  // round to cents
    const netAmount = Math.round((amount - fee) * 100) / 100

    if (netAmount < 0.01) return badRequest('Amount too small after fee')

    // Atomic decrement in DB function: debit the FULL gross amount from balance
    const { data: debitedBalance, error: updateError } = await sb.rpc('hl_withdraw_debit', {
      p_wallet: wallet,
      p_amount: amount,
    })

    if (updateError || debitedBalance === null || debitedBalance === undefined) {
      return badRequest('Insufficient available balance')
    }

    // Send NET amount on-chain (after fee deduction)
    let txHash: string
    try {
      txHash = await sendUsdc(to_wallet, netAmount)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'unknown_error'
      // Refund by compensating increment so concurrent updates are preserved.
      await sb.rpc('hl_withdraw_refund', {
        p_wallet: wallet,
        p_amount: amount,
      })
      await sb.from('hl_transactions').insert({
        wallet,
        type: 'withdraw',
        amount,
        tx_hash: null,
        note: `withdrawal failed to ${to_wallet} (refunded): ${msg}`,
      })
      throw new Error(`On-chain transfer failed: ${msg}`)
    }

    // Record withdrawal transaction (the gross amount the user requested)
    await sb.from('hl_transactions').insert({
      wallet,
      type: 'withdraw',
      amount,
      tx_hash: txHash,
      note: `withdrawal to ${to_wallet} (net $${netAmount.toFixed(2)} after $${fee.toFixed(2)} fee)`,
    })

    // Record platform fee as a separate transaction so it shows up in revenue reporting
    if (fee > 0) {
      await sb.from('hl_transactions').insert({
        wallet: 'platform',
        type: 'fee',
        amount: fee,
        tx_hash: null,
        note: `withdrawal fee from ${wallet}`,
      })
    }

    const newBalance = Number(debitedBalance)

    return ok({
      tx_hash: txHash,
      amount,
      net_amount: netAmount,
      fee,
      balance_usdc: newBalance,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('token') || msg.includes('wallet')) {
      return unauthorized(msg)
    }
    return serverError(e)
  }
}
