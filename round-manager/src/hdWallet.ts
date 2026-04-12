// hdWallet.ts — local copy for round-manager (keep in sync with lib/server/hdWallet.ts)
// SECURITY: never log the mnemonic or private keys. Only public addresses.

import { HDNodeWallet, Mnemonic } from 'ethers'

let cachedRoot: HDNodeWallet | null = null

function getRoot(): HDNodeWallet {
  if (cachedRoot) return cachedRoot
  const phrase = process.env.DEPOSIT_HD_SEED
  if (!phrase) throw new Error('DEPOSIT_HD_SEED env var not set')
  const mnemonic = Mnemonic.fromPhrase(phrase.trim())
  cachedRoot = HDNodeWallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0")
  return cachedRoot
}

export function deriveDepositWallet(index: number): HDNodeWallet {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid HD index: ${index}`)
  }
  return getRoot().deriveChild(index)
}

export function deriveDepositAddress(index: number): string {
  return deriveDepositWallet(index).address.toLowerCase()
}
