import { NextRequest } from 'next/server'
import { verifyAuthFull, unauthorized, ok, badRequest, serverError } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase/server'
import { sendUsdc, getTreasuryUsdcBalance } from '@/lib/withdraw'

const MIN_WITHDRAW = 1
const MAX_WITHDRAW = 10_000
const WITHDRAW_FEE_RATE = 0.03  // 3% withdrawal fee

export async function POST(req: NextRequest) {
  try {
    const auth = await verifyAuthFull(req)
    const body = await req.json()
    const { amount, to_wallet } = body

    if (!amount || amount < MIN_WITHDRAW) return badRequest(`Minimum withdrawal is $${MIN_WITHDRAW}`)
    if (amount > MAX_WITHDRAW) return badRequest(`Maximum withdrawal is $${MAX_WITHDRAW}`)
    if (!to_wallet || typeof to_wallet !== 'string' || !to_wallet.startsWith('0x')) {
      return badRequest('to_wallet required')
    }

    const sb = createServerSupabase()

    // ── Soft lock: refuse if a withdraw is already in progress for this wallet (within last 60s)
    // Wrapped so the withdraw flow still works if hl_idempotency migration hasn't shipped yet.
    try {
      const { data: pendingExisting } = await sb
        .from('hl_idempotency')
        .select('status, created_at')
        .eq('wallet', auth.primaryWallet)
        .eq('operation', 'withdraw')
        .eq('status', 'in_progress')
        .gte('created_at', new Date(Date.now() - 60_000).toISOString())
        .maybeSingle()

      if (pendingExisting) {
        return badRequest('A withdrawal is already in progress. Please wait.')
      }
    } catch (e) {
      console.warn('[WITHDRAW] hl_idempotency lock check failed (table may not exist yet):', e)
    }

    // ── Treasury pre-check: refuse if hot wallet can't cover the net amount
    const fee = Math.round(amount * WITHDRAW_FEE_RATE * 100) / 100
    const netAmount = Math.round((amount - fee) * 100) / 100

    if (netAmount < 0.01) return badRequest('Amount too small after fee')

    let treasuryBalance: number
    try {
      treasuryBalance = await getTreasuryUsdcBalance()
    } catch (e: any) {
      console.error('[WITHDRAW] Treasury balance check failed:', e)
      return badRequest('Withdrawal temporarily unavailable. Please try again.')
    }

    if (treasuryBalance < netAmount) {
      console.error(`[WITHDRAW] Treasury insufficient: has ${treasuryBalance}, need ${netAmount}`)
      return badRequest('Withdrawal temporarily unavailable. Please try again later.')
    }

    // ── Mark idempotency as in-progress (acts as a soft lock for concurrent attempts)
    const idempotencyKey = `withdraw:${auth.primaryWallet}:${Date.now()}`
    let idempotencyTracked = false
    try {
      const { error: insertError } = await sb.from('hl_idempotency').insert({
        idempotency_key: idempotencyKey,
        wallet: auth.primaryWallet,
        operation: 'withdraw',
        status: 'in_progress',
      })
      if (!insertError) idempotencyTracked = true
    } catch (e) {
      console.warn('[WITHDRAW] hl_idempotency insert failed (table may not exist yet):', e)
    }

    // ── Explicit balance check BEFORE the atomic debit.
    // This gives the user a clear error with their actual available amount,
    // and protects against the case where locked_usdc eats into their balance.
    const { data: bal, error: balError } = await sb
      .from('hl_balances')
      .select('balance_usdc, locked_usdc')
      .eq('wallet', auth.primaryWallet)
      .single()

    if (balError || !bal) {
      console.error('[WITHDRAW] Balance lookup failed:', { wallet: auth.primaryWallet, error: balError })
      if (idempotencyTracked) {
        try { await sb.from('hl_idempotency').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('idempotency_key', idempotencyKey) } catch {}
      }
      return badRequest('No balance found for this account')
    }

    const balanceUsdc = Number(bal.balance_usdc) || 0
    const lockedUsdc = Number(bal.locked_usdc) || 0
    const available = balanceUsdc - lockedUsdc

    if (available < amount) {
      console.warn('[WITHDRAW] Insufficient available:', { wallet: auth.primaryWallet, balance: balanceUsdc, locked: lockedUsdc, available, requested: amount })
      if (idempotencyTracked) {
        try { await sb.from('hl_idempotency').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('idempotency_key', idempotencyKey) } catch {}
      }
      return badRequest(`Insufficient available balance. You have $${available.toFixed(2)} available ($${balanceUsdc.toFixed(2)} total, $${lockedUsdc.toFixed(2)} locked in bets).`)
    }

    // ── Phase 1: atomic balance debit (gross amount)
    const { data: debitedBalance, error: updateError } = await sb.rpc('hl_withdraw_debit', {
      p_wallet: auth.primaryWallet,
      p_amount: amount,
    })

    if (updateError || debitedBalance === null || debitedBalance === undefined) {
      console.error('[WITHDRAW] hl_withdraw_debit failed:', { wallet: auth.primaryWallet, amount, error: updateError })
      if (idempotencyTracked) {
        try {
          await sb.from('hl_idempotency').update({
            status: 'failed',
            completed_at: new Date().toISOString(),
          }).eq('idempotency_key', idempotencyKey)
        } catch {}
      }
      return badRequest('Withdrawal failed — please try again')
    }

    // ── Phase 2: send the on-chain transfer
    let txHash: string
    try {
      txHash = await sendUsdc(to_wallet, netAmount)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'unknown_error'
      console.error('[WITHDRAW] On-chain transfer failed, refunding balance:', msg)

      // Refund the gross amount
      await sb.rpc('hl_withdraw_refund', {
        p_wallet: auth.primaryWallet,
        p_amount: amount,
      })

      await sb.from('hl_transactions').insert({
        wallet: auth.primaryWallet,
        type: 'withdraw',
        amount,
        tx_hash: null,
        note: `withdrawal failed to ${to_wallet} (refunded): ${msg}`,
      })

      if (idempotencyTracked) {
        try {
          await sb.from('hl_idempotency').update({
            status: 'failed',
            completed_at: new Date().toISOString(),
          }).eq('idempotency_key', idempotencyKey)
        } catch {}
      }

      throw new Error(`On-chain transfer failed: ${msg}`)
    }

    // ── Phase 3: record the success
    await sb.from('hl_transactions').insert({
      wallet: auth.primaryWallet,
      type: 'withdraw',
      amount,
      tx_hash: txHash,
      note: `withdrawal to ${to_wallet} (net $${netAmount.toFixed(2)} after $${fee.toFixed(2)} fee)`,
    })

    if (fee > 0) {
      await sb.from('hl_transactions').insert({
        wallet: 'platform',
        type: 'fee',
        amount: fee,
        tx_hash: null,
        note: `withdrawal fee from ${auth.primaryWallet}`,
      })
    }

    const newBalance = Number(debitedBalance)
    const responsePayload = {
      tx_hash: txHash,
      amount,
      net_amount: netAmount,
      fee,
      balance_usdc: newBalance,
    }

    if (idempotencyTracked) {
      try {
        await sb.from('hl_idempotency').update({
          status: 'completed',
          response_payload: responsePayload,
          tx_hash: txHash,
          completed_at: new Date().toISOString(),
        }).eq('idempotency_key', idempotencyKey)
      } catch {}
    }

    return ok(responsePayload)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('token') || msg.includes('wallet')) {
      return unauthorized(msg)
    }
    return serverError(e)
  }
}
