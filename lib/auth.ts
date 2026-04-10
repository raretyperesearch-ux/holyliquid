import { PrivyClient } from '@privy-io/server-auth'
import { NextRequest } from 'next/server'

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

export async function verifyAuth(req: NextRequest): Promise<string> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) throw new Error('Missing authorization token')

  // Step 1: verify the JWT and get the user ID
  const claims = await getPrivy().verifyAuthToken(token)

  // Step 2: fetch the full user to get linked accounts
  const user = await getPrivy().getUser(claims.userId)

  const walletAccount = user.linkedAccounts?.find(
    (a: any) => a.type === 'wallet' && a.chainType === 'ethereum'
  ) as any

  if (!walletAccount?.address) throw new Error('No wallet linked to account')
  return walletAccount.address.toLowerCase()
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
