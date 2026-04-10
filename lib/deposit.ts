import { createPublicClient, http, parseAbi, decodeAbiParameters, parseAbiParameters } from 'viem'
import { base } from 'viem/chains'
import { createServerSupabase } from './supabase/server'

const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TREASURY = process.env.TREASURY_WALLET_ADDRESS!

// ERC20 Transfer event + function signatures
const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

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

  // 1. Fetch tx receipt
  const receipt = await client.getTransactionReceipt({
    hash: txHash as `0x${string}`,
  })
  if (!receipt) throw new Error('tx_not_found')
  if (receipt.status !== 'success') throw new Error('tx_failed')

  // 2. Fetch tx itself to check the to address (should be USDC contract)
  const tx = await client.getTransaction({ hash: txHash as `0x${string}` })
  if (!tx) throw new Error('tx_not_found')

  if (tx.to?.toLowerCase() !== USDC_CONTRACT.toLowerCase()) {
    throw new Error('wrong_token_contract')
  }

  // 3. Parse Transfer event from logs
  const transferLog = receipt.logs.find(
    log => log.address.toLowerCase() === USDC_CONTRACT.toLowerCase()
      && log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  )
  if (!transferLog) throw new Error('no_transfer_event')

  // Decode Transfer(from, to, value)
  const [, toTopic, valueTopic] = transferLog.topics
  const to = ('0x' + toTopic.slice(26)).toLowerCase()
  const value = BigInt(valueTopic)

  if (to !== TREASURY.toLowerCase()) throw new Error('wrong_recipient')

  // USDC has 6 decimals
  const amountUsdc = Number(value) / 1_000_000

  if (Math.abs(amountUsdc - claimedAmount) > 0.01) {
    throw new Error(`amount_mismatch: got ${amountUsdc}, claimed ${claimedAmount}`)
  }

  // 4. Check not already credited
  const sb = createServerSupabase()
  const { data: existing } = await sb
    .from('hl_transactions')
    .select('id')
    .eq('tx_hash', txHash)
    .single()

  if (existing) throw new Error('already_credited')

  return amountUsdc
}
