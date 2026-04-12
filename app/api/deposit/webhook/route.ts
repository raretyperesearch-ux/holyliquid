import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createServerSupabase } from '@/lib/supabase/server'
import { deriveDepositWallet } from '@/lib/server/hdWallet'
import { JsonRpcProvider, Wallet, Contract, parseUnits } from 'ethers'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]

function verifySignature(body: string, signature: string): boolean {
  const key = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY
  if (!key) return false
  const hmac = crypto.createHmac('sha256', key).update(body, 'utf8').digest('hex')
  // Both buffers must be the same length for timingSafeEqual
  if (hmac.length !== signature.length) return false
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature))
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const sig = req.headers.get('x-alchemy-signature') || ''
  if (!verifySignature(rawBody, sig)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  let payload: any
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const activity = payload?.event?.activity ?? []
  const sb = createServerSupabase()
  const sweepPromises: Promise<unknown>[] = []

  for (const evt of activity) {
    // Only USDC ERC20 transfers to one of our deposit addresses
    if (evt.category !== 'token' || evt.rawContract?.address?.toLowerCase() !== USDC.toLowerCase()) continue
    const toAddr = (evt.toAddress || '').toLowerCase()
    const txHash = evt.hash
    const amount = Number(evt.value) // Alchemy normalizes ERC-20 values to token units
    if (!toAddr || !txHash || !amount || amount < 0.01) continue

    // Look up which user owns this deposit address
    const { data: users } = await sb.rpc('hl_user_by_deposit_address', { p_address: toAddr })
    const user = users?.[0]
    if (!user) {
      console.warn('[WEBHOOK] No user for deposit address', toAddr)
      continue
    }

    // Reserve the sweep row. Unique constraint on deposit_tx_hash prevents
    // double-credit if Alchemy fires the webhook twice for the same tx.
    const { error: sweepErr } = await sb.from('hl_deposit_sweeps').insert({
      user_wallet: user.wallet,
      deposit_address: toAddr,
      amount,
      deposit_tx_hash: txHash,
      status: 'pending',
    })
    if (sweepErr) {
      if (sweepErr.code === '23505') continue // already processed — idempotent retry path
      console.error('[WEBHOOK] Sweep insert failed:', sweepErr)
      continue
    }

    // Credit the user's balance instantly (don't wait for the sweep to confirm)
    const { error: creditErr } = await sb.rpc('hl_credit_deposit', {
      p_wallet: user.wallet,
      p_amount: amount,
      p_tx_hash: txHash,
    })
    if (creditErr) {
      console.error('[WEBHOOK] Credit failed:', creditErr)
      continue
    }

    await sb.from('hl_transactions').insert({
      wallet: user.wallet,
      type: 'deposit',
      amount,
      tx_hash: txHash,
      note: `deposit from ${toAddr.slice(0, 8)}…`,
    })

    // Queue the async sweep (fire-and-forget — we respond to Alchemy now)
    sweepPromises.push(performSweep(user.deposit_index, toAddr, amount, txHash))
  }

  // Fire-and-forget: respond to Alchemy immediately, let sweeps continue in the background.
  // Stashing the promise on globalThis keeps the serverless function alive long enough
  // to let the sweeps complete without blocking the HTTP response.
  const response = NextResponse.json({ ok: true, processed: activity.length })
  ;(globalThis as unknown as { __sweepKeepAlive?: Promise<unknown> }).__sweepKeepAlive =
    Promise.allSettled(sweepPromises)
  return response
}

async function performSweep(
  index: number,
  depositAddr: string,
  amount: number,
  depositTxHash: string
) {
  const sb = createServerSupabase()
  try {
    const provider = new JsonRpcProvider(process.env.BASE_RPC_URL || 'https://mainnet.base.org')
    const treasuryKey = process.env.TREASURY_PRIVATE_KEY
    if (!treasuryKey) throw new Error('TREASURY_PRIVATE_KEY not set')
    const treasury = new Wallet(treasuryKey, provider)
    const depositWallet = deriveDepositWallet(index).connect(provider)

    // Fund the deposit address with just enough ETH to pay gas for the sweep
    const gasFundTx = await treasury.sendTransaction({
      to: depositAddr,
      value: parseUnits('0.00005', 18),
    })
    await gasFundTx.wait()

    // Transfer USDC from deposit → treasury
    const usdc = new Contract(USDC, USDC_ABI, depositWallet)
    const amountWei = parseUnits(amount.toString(), 6)
    const sweepTx = await usdc.transfer(process.env.TREASURY_WALLET_ADDRESS, amountWei)
    const receipt = await sweepTx.wait()

    await sb
      .from('hl_deposit_sweeps')
      .update({
        status: 'swept',
        sweep_tx_hash: receipt?.hash ?? null,
        swept_at: new Date().toISOString(),
      })
      .eq('deposit_tx_hash', depositTxHash)

    console.log(`[SWEEP] ${depositAddr} → treasury: $${amount} (${receipt?.hash})`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[SWEEP] Failed:', msg)
    await sb
      .from('hl_deposit_sweeps')
      .update({
        status: 'failed',
        error: msg.slice(0, 500),
      })
      .eq('deposit_tx_hash', depositTxHash)
  }
}
