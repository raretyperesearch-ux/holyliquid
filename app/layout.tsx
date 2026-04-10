import type { Metadata } from 'next'
import { PrivyProvider } from '@privy-io/react-auth'
import { base } from 'viem/chains'
import './globals.css'

export const metadata: Metadata = {
  title: 'HolyLiquid — 30-Second Prediction Market',
  description: '10 seconds to bet. 20 seconds of chaos.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;600;700;900&family=Syne:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <PrivyProvider
          appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
          config={{
            loginMethods: ['wallet', 'email'],
            appearance: {
              theme: 'dark',
              accentColor: '#1A1AFF',
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
      </body>
    </html>
  )
}
