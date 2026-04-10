import { createPublicClient, http, parseAbi } from 'viem'
import { base } from 'viem/chains'
import { createServerSupabase } from './supabase/server'

const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function getPublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL),
  })
}

export async function verifyUsdcDeposit(
  txHash: string,
  claimedAmount: number,
  wallet: string
): Promise<number> {
  const client = getPublicClient()

  // 1. Fetch receipt
  const receipt = await client.getTransactionReceipt({
    hash: txHash as `0x${string}`,
  })
  if (!receipt) throw new Error('tx_not_found')
  if (receipt.status !== 'success') throw new Error('tx_failed')

  // 2. Check tx was sent to USDC contract
  const tx = await client.getTransaction({ hash: txHash as `0x${string}` })
  if (!tx) throw new Error('tx_not_found')
  if (tx.to?.toLowerCase() !== USDC_CONTRACT.toLowerCase()) {
    throw new Error('wrong_token_contract')
  }

  // 3. Find Transfer event in logs
  const transferLog = receipt.logs.find(
    log =>
      log.address.toLowerCase() === USDC_CONTRACT.toLowerCase() &&
      log.topics[0] === TRANSFER_TOPIC
  )
  if (!transferLog) throw new Error('no_transfer_event')

  const topics = transferLog.topics
  if (topics.length < 3) throw new Error('invalid_transfer_event')

  const toTopic    = topics[2] // Transfer(from, to, value) — to is index 2
  const valueTopic = transferLog.data  // value is in data for ERC20

  if (!toTopic) throw new Error('missing_to_topic')

  const to    = ('0x' + toTopic.slice(26)).toLowerCase()
  const value = BigInt(valueTopic)

  if (to !== (process.env.TREASURY_WALLET_ADDRESS ?? '').toLowerCase()) {
    throw new Error('wrong_recipient')
  }

  // USDC has 6 decimals
  const amountUsdc = Number(value) / 1_000_000

  if (Math.abs(amountUsdc - claimedAmount) > 0.01) {
    throw new Error(`amount_mismatch: on-chain ${amountUsdc}, claimed ${claimedAmount}`)
  }

  // 4. Check not already credited
  const sb = createServerSupabase()
  const { data: existing } = await sb
    .from('hl_transactions')
    .select('id')
    .eq('tx_hash', txHash)
    .maybeSingle()

  if (existing) throw new Error('already_credited')

  return amountUsdc
}
