'use client'

import { PrivyProvider } from '@privy-io/react-auth'
import { base } from 'viem/chains'

export default function Providers({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID

  // Graceful fallback during build/prerender if env not set
  if (!appId) {
    return <>{children}</>
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['google', 'twitter', 'wallet'],
        appearance: {
          theme: 'dark',
          accentColor: '#9333ea',
          logo: '/logo.png',
          showWalletLoginFirst: false,
        },
        defaultChain: base,
        supportedChains: [base],
        embeddedWallets: {
          createOnLogin: 'users-without-wallets',
        },
      }}
    >
      {children}
    </PrivyProvider>
  )
}
