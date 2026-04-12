// depositSweeper.ts
// Safety-net worker that sweeps any hl_deposit_sweeps rows stuck in `pending`.
// The Next.js webhook handler does fire-and-forget sweeps via globalThis, which
// is unreliable under serverless cold-starts. This worker runs on Railway
// (long-lived process) and catches anything the webhook failed to finish.
//
// Polls every 30s. Picks up rows where:
//   status = 'pending' AND credited_at < now() - 60 seconds
// The 60s grace window lets the webhook's own sweep finish first when it can.

import { JsonRpcProvider, Wallet, Contract, parseUnits } from 'ethers'
import { getSupabaseClient } from './db'
import { deriveDepositWallet } from './hdWallet'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]

const POLL_INTERVAL_MS = 30_000
const GRACE_SECONDS = 60
const MAX_PER_TICK = 5 // avoid nonce contention on treasury wallet

interface PendingSweep {
  deposit_tx_hash: string
  deposit_address: string
  amount: number
  user_wallet: string
}

export function startDepositSweeper() {
  console.log('[SWEEPER] Deposit sweep worker started (30s poll)')
  tick().catch(err => console.error('[SWEEPER] first tick error:', err))
  setInterval(() => {
    tick().catch(err => console.error('[SWEEPER] tick error:', err))
  }, POLL_INTERVAL_MS)
}

async function tick() {
  const sb = getSupabaseClient()
  const cutoff = new Date(Date.now() - GRACE_SECONDS * 1000).toISOString()

  const { data: rows, error } = await sb
    .from('hl_deposit_sweeps')
    .select('deposit_tx_hash, deposit_address, amount, user_wallet')
    .eq('status', 'pending')
    .lt('credited_at', cutoff)
    .order('credited_at', { ascending: true })
    .limit(MAX_PER_TICK)

  if (error) {
    console.error('[SWEEPER] query failed:', error.message)
    return
  }
  if (!rows || rows.length === 0) return

  console.log(`[SWEEPER] ${rows.length} pending row(s) to recover`)

  for (const row of rows as PendingSweep[]) {
    await recoverSweep(row)
  }
}

async function recoverSweep(row: PendingSweep) {
  const sb = getSupabaseClient()

  const { data: user } = await sb
    .from('hl_users')
    .select('deposit_index')
    .eq('wallet', row.user_wallet)
    .single()

  if (!user || user.deposit_index == null) {
    console.error(`[SWEEPER] no HD index for ${row.user_wallet}, marking failed`)
    await sb
      .from('hl_deposit_sweeps')
      .update({ status: 'failed', error: 'no HD index for user' })
      .eq('deposit_tx_hash', row.deposit_tx_hash)
    return
  }

  try {
    const provider = new JsonRpcProvider(process.env.BASE_RPC_URL || 'https://mainnet.base.org')
    const treasuryKey = process.env.TREASURY_PRIVATE_KEY
    if (!treasuryKey) throw new Error('TREASURY_PRIVATE_KEY not set')
    const treasury = new Wallet(treasuryKey, provider)
    const depositWallet = deriveDepositWallet(user.deposit_index).connect(provider)

    // Check on-chain balance first — webhook may have already swept it
    const usdcReader = new Contract(USDC, USDC_ABI, provider)
    const balance: bigint = await usdcReader.balanceOf(row.deposit_address)
    if (balance === 0n) {
      await sb
        .from('hl_deposit_sweeps')
        .update({
          status: 'swept',
          sweep_tx_hash: null,
          swept_at: new Date().toISOString(),
          error: 'recovered: balance already 0 (webhook got it first)',
        })
        .eq('deposit_tx_hash', row.deposit_tx_hash)
      console.log(`[SWEEPER] ${row.deposit_address} already empty, marked swept`)
      return
    }

    const gasFundTx = await treasury.sendTransaction({
      to: row.deposit_address,
      value: parseUnits('0.00005', 18),
    })
    await gasFundTx.wait()

    const usdc = new Contract(USDC, USDC_ABI, depositWallet)
    const sweepTx = await usdc.transfer(process.env.TREASURY_WALLET_ADDRESS, balance)
    const receipt = await sweepTx.wait()

    await sb
      .from('hl_deposit_sweeps')
      .update({
        status: 'swept',
        sweep_tx_hash: receipt?.hash ?? null,
        swept_at: new Date().toISOString(),
      })
      .eq('deposit_tx_hash', row.deposit_tx_hash)

    console.log(`[SWEEPER] recovered ${row.deposit_address} → treasury: $${row.amount} (${receipt?.hash})`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[SWEEPER] recovery failed for ${row.deposit_address}:`, msg)
    await sb
      .from('hl_deposit_sweeps')
      .update({ error: msg.slice(0, 500) })
      .eq('deposit_tx_hash', row.deposit_tx_hash)
    // Leave status as 'pending' so we retry next tick
  }
}
