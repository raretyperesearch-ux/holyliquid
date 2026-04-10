'use client'

/**
 * Lightweight procedural sound system for HolyLiquid.
 *
 * Why procedural (Web Audio oscillators) instead of sample files:
 *  - zero binary assets in the repo
 *  - no network round-trip, no asset versioning
 *  - each sound is a few lines of code you can tune in place
 *  - singleton AudioContext, created lazily on first user gesture
 *
 * If you ever want to swap in real samples, the public API
 * (`getSound().play(name)`) stays the same — only the internals change.
 */

export type SoundName =
  | 'chip'        // chip selection — crisp tick
  | 'side'        // side button select — two-note confirmation
  | 'confirm'     // bet confirm — triumphant triad
  | 'locked'      // invalid/locked action — low thud
  | 'modalOpen'   // modal opening — upward sweep
  | 'modalClose'  // modal closing — downward sweep
  | 'win'         // settle win — ascending chime
  | 'loss'        // settle loss — descending pair
  | 'hover'       // hover — almost imperceptible tick
  | 'toggle'      // sound-enable confirmation

const STORAGE_KEY = 'hl.sound.enabled'
const MASTER_VOL = 0.35 // global ceiling so procedural sounds never cut

class SoundSystem {
  private ctx: AudioContext | null = null
  private enabled = true
  private master: GainNode | null = null

  constructor() {
    if (typeof window === 'undefined') return
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY)
      if (saved !== null) this.enabled = saved === 'true'
    } catch {
      // localStorage can throw in privacy mode / sandboxed iframes; ignore
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(v: boolean): void {
    this.enabled = v
    try {
      window.localStorage.setItem(STORAGE_KEY, String(v))
    } catch {
      // ignore
    }
  }

  /** Ensure an AudioContext exists and is running. Called lazily per play(). */
  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null
    if (!this.ctx) {
      const AC =
        (window as any).AudioContext ||
        (window as any).webkitAudioContext
      if (!AC) return null
      try {
        this.ctx = new AC()
        this.master = this.ctx.createGain()
        this.master.gain.value = MASTER_VOL
        this.master.connect(this.ctx.destination)
      } catch {
        return null
      }
    }
    // Browsers suspend the context until a user gesture. Resume best-effort.
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {})
    }
    return this.ctx
  }

  play(name: SoundName): void {
    if (!this.enabled) return
    const ctx = this.ensureContext()
    if (!ctx || !this.master) return
    const now = ctx.currentTime

    switch (name) {
      case 'chip':
        this.blip(ctx, now, 880, 0.055, 0.18, 'square')
        break
      case 'side':
        this.blip(ctx, now,        660, 0.07, 0.20, 'triangle')
        this.blip(ctx, now + 0.04, 990, 0.06, 0.17, 'triangle')
        break
      case 'confirm':
        // C5 E5 G5 — major triad
        this.blip(ctx, now,        523.25, 0.22, 0.17, 'sine')
        this.blip(ctx, now + 0.06, 659.25, 0.22, 0.17, 'sine')
        this.blip(ctx, now + 0.12, 783.99, 0.32, 0.20, 'sine')
        break
      case 'locked':
        this.blip(ctx, now, 130, 0.14, 0.22, 'sawtooth')
        break
      case 'modalOpen':
        this.sweep(ctx, now, 380, 820, 0.16, 0.13)
        break
      case 'modalClose':
        this.sweep(ctx, now, 820, 300, 0.14, 0.12)
        break
      case 'win':
        // Ascending arpeggio with a final bright note
        this.blip(ctx, now,        523.25, 0.18, 0.16, 'sine')
        this.blip(ctx, now + 0.08, 659.25, 0.18, 0.16, 'sine')
        this.blip(ctx, now + 0.16, 783.99, 0.20, 0.18, 'sine')
        this.blip(ctx, now + 0.26, 1046.5, 0.38, 0.22, 'sine')
        break
      case 'loss':
        this.blip(ctx, now,        330, 0.16, 0.20, 'sawtooth')
        this.blip(ctx, now + 0.10, 196, 0.22, 0.20, 'sawtooth')
        break
      case 'hover':
        this.blip(ctx, now, 1500, 0.025, 0.05, 'sine')
        break
      case 'toggle':
        this.blip(ctx, now,        660, 0.07, 0.16, 'sine')
        this.blip(ctx, now + 0.05, 990, 0.07, 0.16, 'sine')
        break
    }
  }

  /**
   * Short tone with a crisp attack + exponential decay.
   * Using exponentialRampToValueAtTime avoids the clicky tail you get
   * from a straight linear ramp down to zero.
   */
  private blip(
    ctx: AudioContext,
    when: number,
    freq: number,
    dur: number,
    vol: number,
    type: OscillatorType,
  ) {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = type
    osc.frequency.value = freq
    g.gain.setValueAtTime(0.0001, when)
    g.gain.linearRampToValueAtTime(vol, when + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur)
    osc.connect(g)
    g.connect(this.master!)
    osc.start(when)
    osc.stop(when + dur + 0.02)
  }

  /** Frequency sweep — used for modal open/close swoosh. */
  private sweep(
    ctx: AudioContext,
    when: number,
    fromFreq: number,
    toFreq: number,
    dur: number,
    vol: number,
  ) {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(fromFreq, when)
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, toFreq), when + dur)
    g.gain.setValueAtTime(0.0001, when)
    g.gain.linearRampToValueAtTime(vol, when + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur)
    osc.connect(g)
    g.connect(this.master!)
    osc.start(when)
    osc.stop(when + dur + 0.02)
  }
}

let instance: SoundSystem | null = null

/** Lazy singleton accessor. Safe to call during SSR — returns a no-op shim. */
export function getSound(): SoundSystem {
  if (!instance) instance = new SoundSystem()
  return instance
}
