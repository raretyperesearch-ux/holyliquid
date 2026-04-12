import { PrivyClient } from '@privy-io/server-auth'
import { NextRequest } from 'next/server'
import { getLinkedEvmWallets, type LinkedEvmWallet } from './server/privyWallet'

let _privy: PrivyClient | null = null

function getPrivy() {
  if (!_privy) {
    _privy = new PrivyClient(
      process.env.NEXT_PUBLIC_PRIVY_APP_ID!,
      process.env.PRIVY_APP_SECRET!
    )
  }
  return _privy
}

/**
 * Detects the JWT clock-skew errors thrown by jose (underneath Privy):
 *   - `"iat" claim timestamp check failed` — browser clock ahead of server
 *   - `"nbf" claim timestamp check failed` — token not yet valid
 *   - `"exp" claim timestamp check failed` — genuinely expired
 *   - plain `timestamp check failed`
 */
function isClockSkewError(e: unknown): boolean {
  const msg = (e as { message?: string })?.message || ''
  return /timestamp check failed|\b(iat|nbf|exp)\b.*claim/i.test(msg)
}

const CLOCK_SKEW_RETRIES = 3
const CLOCK_SKEW_RETRY_DELAY_MS = 600

/**
 * Verify a Privy auth token with tolerance for small client/server clock
 * skew. If the first attempt fails with an `iat`/`nbf` timestamp error,
 * we wait briefly and retry — a few hundred ms is usually enough for the
 * token to become valid on our clock.
 *
 * All errors are re-thrown with the word "token" in the message so that
 * existing route catch blocks translate them into a clean 401 instead
 * of a 500 with the raw JWT error leaking to the client.
 */
async function verifyTokenTolerant(token: string) {
  const privy = getPrivy()
  let lastError: unknown = null

  for (let attempt = 0; attempt < CLOCK_SKEW_RETRIES; attempt++) {
    try {
      return await privy.verifyAuthToken(token)
    } catch (e) {
      lastError = e
      if (!isClockSkewError(e)) break
      if (attempt < CLOCK_SKEW_RETRIES - 1) {
        await new Promise(r => setTimeout(r, CLOCK_SKEW_RETRY_DELAY_MS))
      }
    }
  }

  if (isClockSkewError(lastError)) {
    throw new Error('token not yet valid — please refresh and try again')
  }
  const msg = (lastError as { message?: string })?.message || 'token verification failed'
  throw new Error(msg.includes('token') ? msg : `token verification failed: ${msg}`)
}

export async function verifyAuth(req: NextRequest): Promise<string> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) throw new Error('Missing authorization token')

  // Step 1: verify the JWT and get the user ID
  const claims = await verifyTokenTolerant(token)

  // Step 2: fetch the full user to get linked accounts
  const user = await getPrivy().getUser(claims.userId)

  const walletAccount = user.linkedAccounts?.find(
    (a: any) => a.type === 'wallet' && a.chainType === 'ethereum'
  ) as any

  if (!walletAccount?.address) throw new Error('No wallet linked to account')
  return walletAccount.address.toLowerCase()
}

export interface AuthContext {
  primaryWallet: string              // lowercased, the wallet stored in hl_balances
  privyUserId: string
  linkedWallets: LinkedEvmWallet[]   // ALL Ethereum wallets the user has linked
  privyUser: unknown                 // raw user object for advanced use
}

/**
 * Same as verifyAuth() but returns the full auth context including ALL
 * linked Ethereum wallets (embedded + external). Deposits should accept
 * any of these as the on-chain source address.
 */
export async function verifyAuthFull(req: NextRequest): Promise<AuthContext> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) throw new Error('Missing authorization token')

  const claims = await verifyTokenTolerant(token)
  const user = await getPrivy().getUser(claims.userId)

  const linkedWallets = getLinkedEvmWallets(user)
  if (linkedWallets.length === 0) {
    throw new Error('No Ethereum wallet on Privy account')
  }

  // Primary = first ethereum wallet in linkedAccounts (matches legacy verifyAuth semantics)
  // so existing hl_balances rows keyed by this wallet keep working.
  const primaryWallet = linkedWallets[0].address

  return {
    primaryWallet,
    privyUserId: claims.userId,
    linkedWallets,
    privyUser: user,
  }
}

export function unauthorized(message = 'Unauthorized') {
  return Response.json({ success: false, error: message }, { status: 401 })
}

export function badRequest(message: string) {
  return Response.json({ success: false, error: message }, { status: 400 })
}

export function ok(data: any) {
  return Response.json({ success: true, data })
}

export function serverError(e: any) {
  console.error('[API Error]', e)
  const message = e?.message || 'Internal server error'
  return Response.json({ success: false, error: message }, { status: 500 })
}
