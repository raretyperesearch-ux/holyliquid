'use client'

const PYTH_URL = 'https://pythdata.app/explore/Crypto.ETH%2FUSD'

export function PythBadge() {
  return (
    <a
      href={PYTH_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="pyth-badge"
      aria-label="Price data verified by Pyth Network"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
      <span>Verified by Pyth</span>
    </a>
  )
}
