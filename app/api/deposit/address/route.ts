import { NextRequest } from 'next/server'
import { verifyAuth, ok, badRequest, serverError } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase/server'
import { deriveDepositAddress } from '@/lib/server/hdWallet'
import { addAddressToAlchemyWebhook } from '@/lib/server/alchemyWebhook'

/**
 * GET /api/deposit/address
 *
 * Returns the user's permanent HD-derived deposit address. On first call,
 * claims a fresh derivation index via `hl_claim_deposit_index` RPC, derives
 * the address from DEPOSIT_HD_SEED, stores it via `hl_assign_deposit_address`,
 * and returns it. Subsequent calls return the cached address from hl_users.
 *
 * The address is deterministic given (DEPOSIT_HD_SEED, index) — if the DB is
 * ever wiped but the seed is preserved, every user's address can be recovered.
 */
export async function GET(req: NextRequest) {
  try {
    const wallet = await verifyAuth(req)
    const sb = createServerSupabase()

    // Fast path: user already has a deposit address provisioned
    const { data: existing } = await sb
      .from('hl_users')
      .select('deposit_address, deposit_index, temp_name')
      .eq('wallet', wallet)
      .single()

    if (existing?.deposit_address) {
      // Fast path — address already provisioned and registered with Alchemy.
      // No need to re-register on every call (it was registered at provisioning time).
      return ok({
        deposit_address: existing.deposit_address,
        temp_name: existing.temp_name,
        chain: 'base',
        token: 'USDC',
        token_contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      })
    }

    // Claim a fresh derivation index atomically
    const { data: indexData, error: indexError } = await sb.rpc('hl_claim_deposit_index', {
      p_wallet: wallet,
    })

    if (indexError || indexData == null) {
      console.error('[DEPOSIT ADDR] Failed to claim index:', indexError)
      return serverError(new Error('Failed to provision deposit address'))
    }

    const index = Number(indexData)
    const address = deriveDepositAddress(index)

    // Store the address (and deposit_index) on hl_users
    const { error: assignError } = await sb.rpc('hl_assign_deposit_address', {
      p_wallet: wallet,
      p_index: index,
      p_address: address,
    })

    if (assignError) {
      console.error('[DEPOSIT ADDR] Failed to store address:', assignError)
      return serverError(new Error('Failed to store deposit address'))
    }

    // Register with Alchemy webhook in the background — don't block the response.
    // If this fails, the Railway deposit sweeper will catch any missed deposits.
    ensureAlchemyAddressRegistration(address, wallet).catch(() => {})

    // Re-fetch so we can include temp_name (which the assign RPC may have generated)
    const { data: refreshed } = await sb
      .from('hl_users')
      .select('deposit_address, temp_name')
      .eq('wallet', wallet)
      .single()

    return ok({
      deposit_address: refreshed?.deposit_address ?? address,
      temp_name: refreshed?.temp_name ?? null,
      chain: 'base',
      token: 'USDC',
      token_contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    if (message.includes('token') || message.includes('wallet')) {
      return badRequest(message)
    }
    return serverError(e)
  }
}

async function ensureAlchemyAddressRegistration(address: string, wallet: string) {
  try {
    await addAddressToAlchemyWebhook(address)
  } catch (error) {
    console.error('[DEPOSIT ADDR] Alchemy registration failed', {
      wallet,
      address,
      error,
    })
    throw new Error(
      'Failed to register your deposit address for webhook monitoring. Please retry in a moment.'
    )
  }
}
