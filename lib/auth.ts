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

  const claims = await getPrivy().verifyAuthToken(token)
  const wallet = claims.linkedAccounts?.find(
    (a: any) => a.type === 'wallet' && a.chainType === 'ethereum'
  )?.address

  if (!wallet) throw new Error('No wallet linked to account')
  return wallet.toLowerCase()
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
