import { createPublicClient, createWalletClient, http, parseAbi, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const USDC_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
])

export async function sendUsdc(
  toWallet: string,
  amount: number
): Promise<string> {
  const privateKey = process.env.TREASURY_PRIVATE_KEY as `0x${string}`
  if (!privateKey) throw new Error('Missing TREASURY_PRIVATE_KEY')

  const account = privateKeyToAccount(privateKey)

  const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL),
  })

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
