'use client'

import { useEffect, useState } from 'react'
import { sounds } from '../../lib/sounds'

export function SoundToggle() {
  const [muted, setMuted] = useState(false)

  // Hydrate from persisted preference. NOTE: we intentionally do NOT call
  // sounds.init() here — useEffect runs outside any user gesture, which on
  // Safari produces a permanently-suspended AudioContext. The module-level
  // unlock listener in lib/sounds.ts handles first-gesture init instead.
  useEffect(() => {
    setMuted(sounds.isMuted())
  }, [])

  const toggle = () => {
    // Ensure the AudioContext is primed inside this click handler. If the
    // user's very first page interaction is the sound toggle itself, this
    // is the only synchronous gesture that can legally create the context
    // on Safari. Must be called before any async work.
    sounds.init()

    const newMuted = sounds.toggleMuted()
    setMuted(newMuted)

    // Fire confirmation click SYNCHRONOUSLY (no setTimeout) — Safari only
    // honors audio calls that happen in the same tick as the user gesture.
    if (!newMuted) {
      sounds.click()
    }
  }

  return (
    <button
      className="sound-toggle"
      onClick={toggle}
      aria-label={muted ? 'Unmute sounds' : 'Mute sounds'}
      type="button"
    >
      {muted ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 5L6 9H2v6h4l5 4V5z"/>
          <line x1="23" y1="9" x2="17" y2="15"/>
          <line x1="17" y1="9" x2="23" y2="15"/>
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 5L6 9H2v6h4l5 4V5z"/>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
        </svg>
      )}
    </button>
  )
}
