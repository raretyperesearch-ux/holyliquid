// lib/server/privyWallet.ts
// Helpers for extracting Ethereum wallets from a Privy user object.
// A single Privy account can have multiple linked wallets (embedded + MetaMask +
// Coinbase + WalletConnect etc.); we accept deposits from any of them.

export interface LinkedEvmWallet {
  address: string            // lowercased
  walletClientType: string   // 'privy' for embedded, 'metamask'/'coinbase_wallet'/... for external
  chainType: 'ethereum'
}

/**
 * Extract all Ethereum wallets linked to a Privy user — embedded + external.
 * Returns them as lowercase addresses.
 */
export function getLinkedEvmWallets(user: unknown): LinkedEvmWallet[] {
  const u = user as { linkedAccounts?: unknown[] } | null
  if (!u?.linkedAccounts || !Array.isArray(u.linkedAccounts)) return []

  return u.linkedAccounts
    .filter((acct): acct is { type: string; address: string; chainType?: string; walletClientType?: string } => {
      const a = acct as { type?: string; chainType?: string; address?: unknown }
      return a?.type === 'wallet' && a?.chainType === 'ethereum' && typeof a?.address === 'string'
    })
    .map((acct) => ({
      address: acct.address.toLowerCase(),
      walletClientType: acct.walletClientType ?? 'unknown',
      chainType: 'ethereum' as const,
    }))
}

/**
 * Resolve a wallet address to one of the user's linked wallets.
 * If `requested` is provided, it must match one of the linked addresses.
 * Otherwise returns the first embedded wallet, or the first wallet if no embedded.
 */
export function resolveLinkedEvmWallet(user: unknown, requested?: string | null): LinkedEvmWallet | null {
  const all = getLinkedEvmWallets(user)
  if (all.length === 0) return null

  if (requested) {
    const match = all.find(w => w.address === requested.toLowerCase())
    return match ?? null
  }

  // Prefer embedded wallet if present
  return all.find(w => w.walletClientType === 'privy') ?? all[0]
}
