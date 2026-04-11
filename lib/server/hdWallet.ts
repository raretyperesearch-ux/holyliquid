// lib/server/hdWallet.ts
// HD wallet derivation for per-user deposit addresses.
// Reads the master mnemonic from DEPOSIT_HD_SEED env var.
//
// SECURITY RULES (read before touching this file):
// 1. NEVER log the mnemonic, any derived private key, or the raw HDNodeWallet object.
//    Only public addresses are safe to log.
// 2. `deriveDepositWallet` returns a wallet with signing capability — use it ONLY
//    from server-side sweep code. Never return it from an API route.
// 3. `deriveDepositAddress` is the endpoint-safe version — it returns only the
//    lowercased address string and discards the private key before returning.
// 4. The cached root is process-local — every Vercel function invocation may
//    re-derive. That's fine (BIP-32 derivation is cheap) and it avoids leaking
//    the root across request contexts.

import { HDNodeWallet, Mnemonic } from 'ethers'

let cachedRoot: HDNodeWallet | null = null

function getRoot(): HDNodeWallet {
  if (cachedRoot) return cachedRoot
  const phrase = process.env.DEPOSIT_HD_SEED
  if (!phrase) throw new Error('DEPOSIT_HD_SEED env var not set')
  const mnemonic = Mnemonic.fromPhrase(phrase.trim())
  // Standard Ethereum derivation: m/44'/60'/0'/0/{index}
  cachedRoot = HDNodeWallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0")
  return cachedRoot
}

/**
 * Derive the deposit wallet (address + private key) for a given index.
 * The returned HDNodeWallet has signing capability — only use this in
 * server-side sweep code, never expose to client or return from an endpoint.
 */
export function deriveDepositWallet(index: number): HDNodeWallet {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid HD index: ${index}`)
  }
  const root = getRoot()
  return root.deriveChild(index)
}

/**
 * Cheap address-only derivation for endpoints that just need the address.
 * Doesn't expose the private key in caller scope — the derived wallet is
 * discarded after extracting the address.
 */
export function deriveDepositAddress(index: number): string {
  return deriveDepositWallet(index).address.toLowerCase()
}
