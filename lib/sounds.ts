// lib/sounds.ts
// Programmatic Web Audio API sound engine. No asset files needed.
// All sounds are synthesized at runtime from oscillators + noise + gain envelopes.
//
// TROUBLESHOOTING GUIDE (read before "simplifying"):
// 1. The `muted` preference is loaded at MODULE LOAD, not inside init(), so
//    `isMuted()` returns the correct value from the very first call.
// 2. `new AudioContext()` must be created SYNCHRONOUSLY inside a user gesture
//    on Safari or the context is born permanently suspended. The module-level
//    unlock listener at the bottom of this file catches the first pointerdown/
//    touchend/keydown/click anywhere on the page and primes the context.
// 3. iOS Safari needs a "silent buffer kick": playing a 1-sample silent
//    AudioBufferSource inside the gesture to actually wake the context.
// 4. All blip/sweep/noise calls use a LOOKAHEAD TIME of ~10ms. Scheduling
//    events at exactly ctx.currentTime is a known footgun: the audio thread
//    may have already passed that sample by the time the event is consumed,
//    and the event gets silently dropped. The lookahead guarantees the
//    scheduled time is strictly in the future.
// 5. Volumes have been bumped significantly from the original spec because
//    laptop speakers + moderate system volume made the original 0.3 peaks
//    inaudible. Current values are loud-but-not-obnoxious on desktop.
// 6. For debugging: `window.__hlSounds` is exposed in the browser. You can
//    type `__hlSounds.click()`, `__hlSounds.ctx.state`, `__hlSounds.isMuted()`
//    in devtools to verify the audio path.

function loadMutedPref(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem('hl_muted') === 'true'
  } catch {
    return false
  }
}

// Lookahead (seconds) added to every scheduled event so we never try to
// start a sound "at" ctx.currentTime — which the audio thread may have
// already passed.
const LOOKAHEAD = 0.01

class SoundEngine {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  // Load muted preference synchronously at construction (module load).
  private muted: boolean = loadMutedPref()
  private initialized: boolean = false

  init() {
    if (this.initialized || typeof window === 'undefined') return
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx) {
        console.warn('[Sounds] Web Audio API not supported')
        return
      }
      this.ctx = new Ctx()
      this.masterGain = this.ctx.createGain()
      // 0.9 master — loud enough to hear on laptop speakers with moderate volume.
      this.masterGain.gain.value = 0.9
      this.masterGain.connect(this.ctx.destination)
      this.initialized = true

      // Safari unlock kick: play a 1-sample silent buffer inside the gesture.
      try {
        const buffer = this.ctx.createBuffer(1, 1, 22050)
        const src = this.ctx.createBufferSource()
        src.buffer = buffer
        src.connect(this.ctx.destination)
        src.start(0)
      } catch (e) {
        console.warn('[Sounds] Silent-buffer kick failed:', e)
      }

      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch((e) => {
          console.warn('[Sounds] ctx.resume() failed:', e)
        })
      }

      console.log('[Sounds] Initialized. state =', this.ctx.state, 'sampleRate =', this.ctx.sampleRate)
    } catch (e) {
      console.warn('[Sounds] Init failed:', e)
    }
  }

  /**
   * Called from the global unlock listener on the first user gesture.
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

  /** Debug helper — exposed on window for devtools testing. */
  getState() {
    return {
      initialized: this.initialized,
      muted: this.muted,
      ctxState: this.ctx?.state ?? 'no-ctx',
      masterVolume: this.masterGain?.gain.value ?? 0,
      sampleRate: this.ctx?.sampleRate ?? 0,
    }
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
    const t = this.now() + LOOKAHEAD + delay
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
    const t = this.now() + LOOKAHEAD + delay
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
    const t = this.now() + LOOKAHEAD + delay
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
  // Volumes are tuned to be clearly audible on laptop speakers at moderate
  // system volume. Don't drop them without listening on cheap hardware first.

  // Generic UI click
  click() {
    this.ensureInit()
    this.blip(900, 0.05, 'sine', 0.7)
  }

  hover() {
    this.ensureInit()
    this.blip(600, 0.025, 'sine', 0.3)
  }

  // Bet placed: chip-stack clack
  bet() {
    this.ensureInit()
    this.blip(1200, 0.04, 'square', 0.55, 0)
    this.blip(1100, 0.04, 'square', 0.5, 0.03)
    this.blip(1350, 0.04, 'square', 0.45, 0.06)
  }

  // Round win: ascending C major arpeggio with sparkle
  win() {
    this.ensureInit()
    this.blip(523, 0.18, 'sine', 0.7, 0)       // C5
    this.blip(659, 0.18, 'sine', 0.7, 0.09)    // E5
    this.blip(783, 0.18, 'sine', 0.7, 0.18)    // G5
    this.blip(1046, 0.45, 'sine', 0.8, 0.27)   // C6
    this.blip(2093, 0.35, 'sine', 0.35, 0.33)  // sparkle C7
  }

  // Round loss: descending sad two-note
  loss() {
    this.ensureInit()
    this.blip(440, 0.28, 'triangle', 0.65, 0)
    this.blip(370, 0.5, 'triangle', 0.65, 0.2)
  }

  // Liquidation: crash + low rumble
  liq() {
    this.ensureInit()
    this.noise(0.45, 0.7)
    this.sweep(220, 60, 0.65, 'sawtooth', 0.8)
    this.sweep(440, 100, 0.55, 'square', 0.4, 0.05)
  }

  // Cashout / payout: bell ka-ching
  cashout() {
    this.ensureInit()
    this.blip(1318, 0.22, 'sine', 0.7, 0)
    this.blip(1568, 0.42, 'sine', 0.7, 0.09)
    this.blip(2637, 0.32, 'sine', 0.35, 0.09)
  }

  tick() {
    this.ensureInit()
    this.blip(1500, 0.025, 'sine', 0.28)
  }

  roundOpen() {
    this.ensureInit()
    this.sweep(220, 660, 0.3, 'sine', 0.55)
  }
}

export const sounds = new SoundEngine()

// Expose on window for devtools debugging. Type `__hlSounds.getState()` in
// the console to see initialization state; `__hlSounds.click()` to test
// audio path manually.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __hlSounds: SoundEngine }).__hlSounds = sounds
}

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
