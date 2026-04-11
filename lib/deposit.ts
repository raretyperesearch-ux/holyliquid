import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { createServerSupabase } from './supabase/server'

const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const MAX_TX_AGE_SECONDS = 600  // reject deposits older than 10 minutes

function getPublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL),
  })
}

/**
 * Verifies a USDC deposit transaction against a set of allowed source addresses.
 *
 * Security checks:
 *   1. Receipt exists and tx status = success
 *   2. Tx `to` is the USDC contract
 *   3. Transfer event present, `to` is the configured treasury wallet
 *   4. Transfer event `from` is in `allowedFroms` (one of the user's linked wallets)
 *   5. On-chain value matches claimed amount within 1 cent
 *   6. Tx is ≤ MAX_TX_AGE_SECONDS old (prevents re-claiming stale transfers)
 *   7. Tx hash not already in hl_transactions (idempotency backstop)
 *
 * Returns the on-chain amount in USDC (6 decimals → float).
 */
export async function verifyUsdcDeposit(
  txHash: string,
  claimedAmount: number,
  allowedFroms: string[]
): Promise<number> {
  const client = getPublicClient()

  // 1. Fetch receipt
  const receipt = await client.getTransactionReceipt({
    hash: txHash as `0x${string}`,
  })
  if (!receipt) throw new Error('tx_not_found')
  if (receipt.status !== 'success') throw new Error('tx_failed')

  // 2. Fetch tx (for block number + to-check)
  const tx = await client.getTransaction({ hash: txHash as `0x${string}` })
  if (!tx) throw new Error('tx_not_found')
  if (tx.to?.toLowerCase() !== USDC_CONTRACT.toLowerCase()) {
    throw new Error('wrong_token_contract')
  }

  // 3. Fetch block for timestamp check
  if (tx.blockNumber == null) throw new Error('tx_not_mined')
  const block = await client.getBlock({ blockNumber: tx.blockNumber })
  const txAgeSeconds = Math.floor(Date.now() / 1000) - Number(block.timestamp)
  if (txAgeSeconds > MAX_TX_AGE_SECONDS) {
    throw new Error(`tx_too_old: ${txAgeSeconds}s old, max ${MAX_TX_AGE_SECONDS}s`)
  }

  // 4. Find Transfer event in logs
  const transferLog = receipt.logs.find(
    log =>
      log.address.toLowerCase() === USDC_CONTRACT.toLowerCase() &&
      log.topics[0] === TRANSFER_TOPIC
  )
  if (!transferLog) throw new Error('no_transfer_event')

  const topics = transferLog.topics
  if (topics.length < 3) throw new Error('invalid_transfer_event')

  const fromTopic  = topics[1] // Transfer(indexed from, indexed to, value)
  const toTopic    = topics[2]
  const valueTopic = transferLog.data

  if (!fromTopic) throw new Error('missing_from_topic')
  if (!toTopic) throw new Error('missing_to_topic')

  const from  = ('0x' + fromTopic.slice(26)).toLowerCase()
  const to    = ('0x' + toTopic.slice(26)).toLowerCase()
  const value = BigInt(valueTopic)

  // 5. Recipient must be the treasury
  if (to !== (process.env.TREASURY_WALLET_ADDRESS ?? '').toLowerCase()) {
    throw new Error('wrong_recipient')
  }

  // 6. Sender must be one of the user's linked wallets
  const allowedSet = new Set(allowedFroms.map(a => a.toLowerCase()))
  if (!allowedSet.has(from)) {
    throw new Error('Transaction not sent from one of your linked wallets')
  }

  // 7. Amount must match claim within 1 cent
  const amountUsdc = Number(value) / 1_000_000
  if (Math.abs(amountUsdc - claimedAmount) > 0.01) {
    throw new Error(`amount_mismatch: on-chain ${amountUsdc}, claimed ${claimedAmount}`)
  }

  // 8. Backstop: not already credited (hl_transactions tx_hash unique)
  const sb = createServerSupabase()
  const { data: existing } = await sb
    .from('hl_transactions')
    .select('id')
    .eq('tx_hash', txHash)
    .maybeSingle()

  if (existing) throw new Error('already_credited')

  return amountUsdc
}
