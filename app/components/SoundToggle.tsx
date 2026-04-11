'use client'

import { useEffect, useState } from 'react'
import { sounds } from '../../lib/sounds'

export function SoundToggle() {
  const [muted, setMuted] = useState(false)

  useEffect(() => {
    sounds.init()
    setMuted(sounds.isMuted())
  }, [])

  const toggle = () => {
    const newMuted = sounds.toggleMuted()
    setMuted(newMuted)
    // Play a click confirmation if we just unmuted
    if (!newMuted) {
      setTimeout(() => sounds.click(), 0)
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
