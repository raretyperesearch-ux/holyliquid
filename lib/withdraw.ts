import { createPublicClient, createWalletClient, http, parseAbi, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const USDC_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
])

function getPublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL),
  })
}

export async function sendUsdc(
  toWallet: string,
  amount: number
): Promise<string> {
  const privateKey = process.env.TREASURY_PRIVATE_KEY as `0x${string}`
  if (!privateKey) throw new Error('Missing TREASURY_PRIVATE_KEY')

  const account = privateKeyToAccount(privateKey)

  const publicClient = getPublicClient()

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(process.env.BASE_RPC_URL),
  })

  // USDC has 6 decimals
  const amountRaw = parseUnits(amount.toFixed(6), 6)

  const hash = await walletClient.writeContract({
    address: USDC_CONTRACT,
    abi: USDC_ABI,
    functionName: 'transfer',
    args: [toWallet as `0x${string}`, amountRaw],
  })

  // Wait for confirmation
  await publicClient.waitForTransactionReceipt({ hash })

  return hash
}

/**
 * Reads the current USDC balance of the treasury hot wallet on Base.
 * Used as a pre-check before withdrawal to refuse cashouts the treasury can't cover.
 */
export async function getTreasuryUsdcBalance(): Promise<number> {
  const treasuryAddress = process.env.TREASURY_WALLET_ADDRESS
  if (!treasuryAddress) throw new Error('TREASURY_WALLET_ADDRESS not set')

  const publicClient = getPublicClient()

  const balance = await publicClient.readContract({
    address: USDC_CONTRACT as `0x${string}`,
    abi: USDC_ABI,
    functionName: 'balanceOf',
    args: [treasuryAddress as `0x${string}`],
  })

  // USDC has 6 decimals
  return Number(balance) / 1_000_000
}
