// lib/sounds.ts
// Programmatic Web Audio API sound engine. No asset files needed.
// All sounds are synthesized at runtime from oscillators + noise + gain envelopes.
//
// Safari unlock notes (important — do not "simplify" without testing on iOS):
// 1. The `muted` preference is loaded at MODULE LOAD, not inside init(), so
//    `isMuted()` returns the correct value from the very first call (before
//    the AudioContext even exists).
// 2. `new AudioContext()` must be created SYNCHRONOUSLY inside a user gesture
//    on Safari or the context is born permanently suspended. We install a
//    one-time global unlock listener at the bottom of this file that catches
//    the first `pointerdown`/`touchend`/`keydown`/`click` anywhere on the page
//    and primes the context from inside that gesture.
// 3. iOS Safari needs a "silent buffer kick": playing a 1-sample silent
//    AudioBufferSource inside the gesture to actually wake the context.
//    `ctx.resume()` alone resolves successfully but leaves the context silent
//    on some iOS versions.
// 4. Public sound methods (`click`, `bet`, `win`, ...) must be called
//    synchronously from inside click/touch handlers. Never wrap them in
//    setTimeout/setImmediate/Promise.resolve().then — that breaks Safari's
//    user-gesture chain and audio is dropped.

function loadMutedPref(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem('hl_muted') === 'true'
  } catch {
    return false
  }
}

class SoundEngine {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  // Load muted preference synchronously at construction (module load).
  // This guarantees `isMuted()` is correct before any init() has run.
  private muted: boolean = loadMutedPref()
  private initialized: boolean = false

  init() {
    if (this.initialized || typeof window === 'undefined') return
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return
      this.ctx = new Ctx()
      this.masterGain = this.ctx.createGain()
      this.masterGain.gain.value = 0.4
      this.masterGain.connect(this.ctx.destination)
      this.initialized = true

      // Safari unlock kick: play a 1-sample silent buffer inside the gesture
      // that triggered init(). This is the only reliable way to actually wake
      // the AudioContext on iOS — `ctx.resume()` alone isn't enough.
      try {
        const buffer = this.ctx.createBuffer(1, 1, 22050)
        const src = this.ctx.createBufferSource()
        src.buffer = buffer
        src.connect(this.ctx.destination)
        src.start(0)
      } catch {}

      // Resume context if it was suspended (Chrome autoplay policy + Safari)
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {})
      }
    } catch (e) {
      console.warn('[Sounds] Init failed:', e)
    }
  }

  /**
   * Called from the global one-time unlock listener on the first user gesture.
   * Also safe to call from any public sound method.
   */
  unlock() {
    if (!this.initialized) this.init()
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {})
    }
  }

  private ensureInit() {
    if (!this.initialized) this.init()
    // If context was suspended after init, try to resume (user gesture)
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {})
    }
  }

  isMuted(): boolean {
    return this.muted
  }

  setMuted(m: boolean) {
    this.muted = m
    try { window.localStorage.setItem('hl_muted', String(m)) } catch {}
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted)
    return this.muted
  }

  private now(): number {
    return this.ctx?.currentTime ?? 0
  }

  // Single oscillator with attack-decay envelope
  private blip(
    freq: number,
    duration: number,
    type: OscillatorType = 'sine',
    volume: number = 1,
    delay: number = 0
  ) {
    if (!this.ctx || !this.masterGain || this.muted) return
    const t = this.now() + delay
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t)
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(volume, t + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration)
    osc.connect(gain)
    gain.connect(this.masterGain)
    osc.start(t)
    osc.stop(t + duration + 0.02)
  }

  // White noise burst
  private noise(duration: number, volume: number = 0.5, delay: number = 0) {
    if (!this.ctx || !this.masterGain || this.muted) return
    const t = this.now() + delay
    const buffer = this.ctx.createBuffer(1, Math.max(1, Math.floor(this.ctx.sampleRate * duration)), this.ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    const gain = this.ctx.createGain()
    gain.gain.setValueAtTime(volume, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration)
    src.connect(gain)
    gain.connect(this.masterGain)
    src.start(t)
  }

  // Frequency-sweeping oscillator (rises or falls)
  private sweep(
    startFreq: number,
    endFreq: number,
    duration: number,
    type: OscillatorType = 'sine',
    volume: number = 1,
    delay: number = 0
  ) {
    if (!this.ctx || !this.masterGain || this.muted) return
    const t = this.now() + delay
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(startFreq, t)
    osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), t + duration)
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(volume, t + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration)
    osc.connect(gain)
    gain.connect(this.masterGain)
    osc.start(t)
    osc.stop(t + duration + 0.02)
  }

  // ── PUBLIC SOUND METHODS ─────────────────────────────────────

  // Generic UI click
  click() {
    this.ensureInit()
    this.blip(800, 0.04, 'sine', 0.3)
  }

  // Subtle hover (use sparingly — can get annoying)
  hover() {
    this.ensureInit()
    this.blip(600, 0.025, 'sine', 0.1)
  }

  // Bet placed: chip-stack clack
  bet() {
    this.ensureInit()
    this.blip(1200, 0.03, 'square', 0.2, 0)
    this.blip(1100, 0.03, 'square', 0.18, 0.025)
    this.blip(1350, 0.03, 'square', 0.16, 0.05)
  }

  // Round win: ascending C major arpeggio with sparkle
  win() {
    this.ensureInit()
    this.blip(523, 0.15, 'sine', 0.35, 0)      // C5
    this.blip(659, 0.15, 'sine', 0.35, 0.08)   // E5
    this.blip(783, 0.15, 'sine', 0.35, 0.16)   // G5
    this.blip(1046, 0.4, 'sine', 0.4, 0.24)    // C6
    this.blip(2093, 0.3, 'sine', 0.15, 0.3)    // sparkle C7
  }

  // Round loss: descending sad two-note
  loss() {
    this.ensureInit()
    this.blip(440, 0.25, 'triangle', 0.3, 0)
    this.blip(370, 0.45, 'triangle', 0.3, 0.18)
  }

  // Liquidation: crash + low rumble
  liq() {
    this.ensureInit()
    this.noise(0.4, 0.35)
    this.sweep(220, 60, 0.6, 'sawtooth', 0.4)
    this.sweep(440, 100, 0.5, 'square', 0.2, 0.05)
  }

  // Cashout / payout: bell ka-ching
  cashout() {
    this.ensureInit()
    this.blip(1318, 0.2, 'sine', 0.35, 0)      // E6
    this.blip(1568, 0.4, 'sine', 0.35, 0.08)   // G6
    this.blip(2637, 0.3, 'sine', 0.15, 0.08)   // E7 sparkle
  }

  // Countdown tick
  tick() {
    this.ensureInit()
    this.blip(1500, 0.02, 'sine', 0.12)
  }

  // Round opening: rising swoosh
  roundOpen() {
    this.ensureInit()
    this.sweep(220, 660, 0.3, 'sine', 0.25)
  }
}

export const sounds = new SoundEngine()

// ── Global one-time unlock listener ───────────────────────────
// Safari requires `new AudioContext()` to be created synchronously inside a
// user gesture. Listen for the very first interaction anywhere on the page
// and prime the context from inside that gesture. Uses capture-phase and
// removes itself after firing once.
if (typeof window !== 'undefined') {
  const unlockEvents: Array<keyof WindowEventMap> = [
    'pointerdown',
    'touchend',
    'keydown',
    'click',
  ]
  const unlock = () => {
    sounds.unlock()
    unlockEvents.forEach((ev) => {
      window.removeEventListener(ev, unlock, true)
    })
  }
  unlockEvents.forEach((ev) => {
    window.addEventListener(ev, unlock, true)
  })
}
