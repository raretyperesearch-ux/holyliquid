'use client'
import { useEffect, useRef } from 'react'

interface Props {
  priceHistory: number[]
  pnlPos: boolean
}

export default function PriceWaterChart({ priceHistory, pnlPos }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef({
    prices: priceHistory,
    pnlPos,
    t: 0,
    pnlBlend: pnlPos ? 1 : 0,
    boatY: 100, boatVY: 0,
    boatX: 0,   boatVX: 0,
    boatTilt: 0, boatTiltV: 0,
  })
  const animRef = useRef(0)
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 })

  useEffect(() => {
    stateRef.current.prices = priceHistory.length >= 2 ? priceHistory : [0, 0]
  }, [priceHistory])

  useEffect(() => {
    // Smooth blend target
    stateRef.current.pnlPos = pnlPos
  }, [pnlPos])

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const parent = cv.parentElement
    if (!parent) return

    const applySize = () => {
      const rect = parent.getBoundingClientRect()
      const width  = Math.max(1, Math.round(rect.width))
      const height = Math.max(1, Math.round(rect.height))
      const dpr    = Math.max(1, Math.min(window.devicePixelRatio || 1, 2))

      const nextBufferWidth  = Math.round(width  * dpr)
      const nextBufferHeight = Math.round(height * dpr)

      if (
        cv.width  !== nextBufferWidth  ||
        cv.height !== nextBufferHeight ||
        sizeRef.current.width  !== width  ||
        sizeRef.current.height !== height ||
        sizeRef.current.dpr    !== dpr
      ) {
        cv.width  = nextBufferWidth
        cv.height = nextBufferHeight
        sizeRef.current = { width, height, dpr }

        // Pin boat X relative to scene, preserve existing Y instead of snapping from stale values
        stateRef.current.boatX = width * 0.58
        stateRef.current.boatY = Math.min(stateRef.current.boatY || height * 0.5, height)
      }
    }
    const resize = () => requestAnimationFrame(applySize)
    applySize()
    window.addEventListener('resize', resize)
    const ro = new ResizeObserver(() => { resize() })
    ro.observe(parent)  // observe parent layout box — survives canvas buffer resets

    const CLOUDS = [
      {x:0,    y:18, w:90,  h:22, spd:.12, alpha:.55},
      {x:0,    y:10, w:130, h:28, spd:.08, alpha:.45},
      {x:0,    y:22, w:70,  h:18, spd:.10, alpha:.5},
      {x:0,    y:30, w:80,  h:16, spd:.06, alpha:.3},
      {x:0,    y:28, w:110, h:20, spd:.05, alpha:.28},
    ]
    const DROPS: any[] = []
    for (let i = 0; i < 110; i++) {
      const d = Math.random()
      DROPS.push({ x: Math.random(), y: Math.random(), len: 5+d*14, spd: 4+d*9, alpha: .12+d*.35, width: .5+d*.7, depth: d })
    }
    const RIPPLES: any[] = [], SPRAY: any[] = []
    type FallingCoin = { x: number; y: number; vx: number; vy: number; life: number; spin: number; size: number }
    const FALLING_COINS: FallingCoin[] = []
    const DECK_COINS = [
      { x: 2.5, y: -1.1, p: 0.0, r: 1.25 },
      { x: 4.1, y: -1.4, p: 1.3, r: 1.1 },
      { x: 5.4, y: -0.95, p: 2.1, r: 0.95 },
      { x: 3.3, y: -1.8, p: 2.9, r: 0.82 },
    ]
    let nextCoinDropT = 1.8
    let lightningFlash = 0, lightningX = 0
    let cloudsInit = false
    let lastSceneWidth = 0
    let lastSceneHeight = 0

    const lerp = (a: number, b: number, n: number) => a + (b - a) * n
    const SK = 0.045, SD = 0.72

    // EMA-smooth a price series. alpha controls responsiveness: lower = calmer.
    function emaSmooth(prices: number[], alpha = 0.18): number[] {
      if (prices.length === 0) return prices
      const out = new Array<number>(prices.length)
      out[0] = prices[0]
      for (let i = 1; i < prices.length; i++) {
        out[i] = out[i - 1] + alpha * (prices[i] - out[i - 1])
      }
      return out
    }

    // Re-derived on each frame from the latest prices. Keeps a stable reference
    // so getBaseY doesn't need to rebuild its min/mid math on every x sample.
    let smoothedPrices: number[] = []
    let smoothedMin = 0
    let smoothedMax = 0
    let smoothedMid = 0
    let smoothedPaddedRange = 1
    let rawPrices: number[] = []
    let rawMid = 0
    let rawPaddedRange = 1

    function refreshSmoothedPrices(prices: number[]) {
      smoothedPrices = emaSmooth(prices, 0.18)
      rawPrices = prices.slice()
      if (smoothedPrices.length === 0) {
        smoothedMin = 0; smoothedMax = 0; smoothedMid = 0; smoothedPaddedRange = 1; rawMid = 0; rawPaddedRange = 1
        return
      }
      let mn = smoothedPrices[0], mx = smoothedPrices[0]
      for (let i = 1; i < smoothedPrices.length; i++) {
        const p = smoothedPrices[i]
        if (p < mn) mn = p
        if (p > mx) mx = p
      }
      // Pad the range so tiny price movements don't look like tsunamis.
      // Use max of: 1.8x raw, 0.2% of price level, and an absolute floor.
      const rawRange = mx - mn
      const padded = Math.max(rawRange * 1.8, Math.abs(mx) * 0.002, 1e-9)
      smoothedMin = mn
      smoothedMax = mx
      smoothedMid = (mx + mn) / 2
      smoothedPaddedRange = padded
      let rmn = rawPrices[0], rmx = rawPrices[0]
      for (let i = 1; i < rawPrices.length; i++) {
        const p = rawPrices[i]
        if (p < rmn) rmn = p
        if (p > rmx) rmx = p
      }
      rawMid = (rmx + rmn) / 2
      rawPaddedRange = Math.max((rmx - rmn) * 1.4, Math.abs(rmx) * 0.0018, 1e-9)
    }

    function getBaseY(x: number, W: number, H: number): number {
      if (smoothedPrices.length === 0) return H * 0.5
      const ratio = x / Math.max(1, W - 1)
      const idx = ratio * (smoothedPrices.length - 1)
      const i1 = Math.max(0, Math.min(smoothedPrices.length - 1, Math.floor(idx)))
      const i2 = Math.max(0, Math.min(smoothedPrices.length - 1, i1 + 1))
      const i0 = Math.max(0, Math.min(smoothedPrices.length - 1, i1 - 1))
      const i3 = Math.max(0, Math.min(smoothedPrices.length - 1, i2 + 1))
      const t = idx - i1
      const p0 = smoothedPrices[i0]
      const p1 = smoothedPrices[i1]
      const p2 = smoothedPrices[i2]
      const p3 = smoothedPrices[i3]
      const t2 = t * t
      const t3 = t2 * t
      const v = 0.5 * (
        (2 * p1) +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t3
      )
      // Normalize against the padded range centered on mid — calmer, premium feel.
      const normalized = (v - (smoothedMid - smoothedPaddedRange / 2)) / smoothedPaddedRange
      // Clamp defensively so a noisy single sample can't shoot off-screen.
      const clamped = Math.max(0, Math.min(1, normalized))
      return H * 0.08 + (H * 0.66) - clamped * (H * 0.66)
    }

    function getY(x: number, chop: number, t: number, W: number, H: number): number {
      const b = getBaseY(x, W, H)
      // Main waterline should be the chart path first; motion is subtle physics.
      return b
        + Math.sin(x * .02 + t * 1.6) * 0.55 * chop
        + Math.sin(x * .038 - t * 1.25) * 0.35 * chop
        + Math.sin(x * .08 + t * 2.2) * 0.14
    }

    function drawCloud(ctx: CanvasRenderingContext2D, cx: number, cy: number, cw: number, ch: number, alpha: number, blend: number) {
      if (blend < .03) return
      ctx.save(); ctx.globalAlpha = alpha * blend
      for (const b of [
        {ox:0,     oy:0,       rx:cw*.38, ry:ch*.55},
        {ox:cw*.25,oy:-ch*.18, rx:cw*.32, ry:ch*.65},
        {ox:-cw*.2,oy:-ch*.1,  rx:cw*.28, ry:ch*.55},
        {ox:cw*.45,oy:ch*.05,  rx:cw*.25, ry:ch*.45},
        {ox:-cw*.38,oy:ch*.05, rx:cw*.22, ry:ch*.4},
      ]) {
        const cg = ctx.createRadialGradient(cx+b.ox, cy+b.oy, 0, cx+b.ox, cy+b.oy, Math.max(b.rx, b.ry))
        cg.addColorStop(0, 'rgba(30,30,55,0.85)')
        cg.addColorStop(.5,'rgba(20,20,42,0.6)')
        cg.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = cg; ctx.beginPath()
        ctx.ellipse(cx+b.ox, cy+b.oy, b.rx, b.ry, 0, 0, Math.PI*2); ctx.fill()
      }
      ctx.restore()
    }

    function draw() {
      animRef.current = requestAnimationFrame(draw)
      const st = stateRef.current
      st.t += .016
      const t = st.t
      const { prices } = st

      // Smooth pnlBlend
      const targetBlend = st.pnlPos ? 1 : 0
      st.pnlBlend = lerp(st.pnlBlend, targetBlend, .025)
      const B = st.pnlBlend
      const chop = lerp(1, 0.78, B)

      const { width: W, height: H, dpr } = sizeRef.current
      if (!W || !H) return  // not sized yet

      const ctx2 = cv!.getContext('2d')!
      ctx2.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx2.clearRect(0, 0, W, H)

      // Init cloud/drop positions; on resize, rescale proportionally instead of snapping
      if (!cloudsInit || lastSceneWidth !== W || lastSceneHeight !== H) {
        if (lastSceneWidth && lastSceneHeight) {
          const sx = W / lastSceneWidth
          const sy = H / lastSceneHeight
          for (const c of CLOUDS) { c.x *= sx; c.y *= sy; c.w *= sx; c.h *= sy }
          for (const d of DROPS)  { d.x *= sx; d.y *= sy }
        } else {
          CLOUDS[0].x = W*.1; CLOUDS[1].x = W*.45; CLOUDS[2].x = W*.78
          CLOUDS[3].x = W*.25; CLOUDS[4].x = W*.65
          for (const d of DROPS) { d.x *= W; d.y *= H }
        }
        cloudsInit = true
        lastSceneWidth = W
        lastSceneHeight = H
      }

      // Rebuild the smoothed price series once per frame (not per x).
      refreshSmoothedPrices(prices)

      const s: number[] = []
      for (let x = 0; x < W; x++) {
        s.push(getY(x, chop, t, W, H))
      }
      const skyH = s[0] + 8
      const rn = (n: number) => Math.round(n)

      // SKY
      const skyG = ctx2.createLinearGradient(0, 0, 0, skyH)
      skyG.addColorStop(0,   `rgb(${rn(lerp(6,5,B))},${rn(lerp(6,8,B))},${rn(lerp(18,10,B))})`)
      skyG.addColorStop(.45, `rgb(${rn(lerp(12,26,B))},${rn(lerp(14,16,B))},${rn(lerp(40,96,B))})`)
      skyG.addColorStop(1,   `rgb(${rn(lerp(18,42,B))},${rn(lerp(18,24,B))},${rn(lerp(50,128,B))})`)
      ctx2.fillStyle = skyG; ctx2.fillRect(0, 0, W, skyH)

      // Stars
      for (let i = 0; i < 26; i++) {
        const sx = (i*173)%W, sy = (i*97)%(skyH*.85)
        const a = (0.12+.3*Math.abs(Math.sin(t*1.4+i*.9)))*(1-B*.7)
        if (a < .02) continue
        ctx2.beginPath(); ctx2.arc(sx, sy, .7, 0, Math.PI*2)
        ctx2.fillStyle = `rgba(255,255,255,${a})`; ctx2.fill()
      }

      // SUN
      if (B > .05) {
        const SX = W*.78, SY = 26
        const haze = ctx2.createRadialGradient(SX,SY,0,SX,SY,90)
        haze.addColorStop(0,`rgba(255,200,60,${.18*B})`); haze.addColorStop(.3,`rgba(255,160,30,${.07*B})`)
        haze.addColorStop(.6,`rgba(255,120,10,${.03*B})`); haze.addColorStop(1,'rgba(0,0,0,0)')
        ctx2.fillStyle = haze; ctx2.fillRect(SX-90, 0, 180, skyH)
        const horizG = ctx2.createLinearGradient(0, skyH-33, 0, skyH+5)
        horizG.addColorStop(0,'rgba(0,0,0,0)'); horizG.addColorStop(.4,`rgba(255,140,40,${.06*B})`)
        horizG.addColorStop(1,`rgba(255,100,20,${.1*B})`)
        ctx2.fillStyle = horizG; ctx2.fillRect(0, skyH-33, W, 38)
        ctx2.save(); ctx2.translate(SX, SY)
        for (let i = 0; i < 16; i++) {
          const ang = (i/16)*Math.PI*2+t*.18, r2 = 22+Math.sin(t*2.2+i*1.3)*6
          ctx2.beginPath()
          ctx2.moveTo(Math.cos(ang)*13, Math.sin(ang)*13)
          ctx2.lineTo(Math.cos(ang)*r2, Math.sin(ang)*r2)
          ctx2.strokeStyle = `rgba(255,215,80,${(.08+.06*Math.sin(t*1.5+i))*B})`
          ctx2.lineWidth = 2.2+Math.sin(t+i)*.8; ctx2.stroke()
        }
        ctx2.restore()
        const sunG = ctx2.createRadialGradient(SX-3,SY-3,0,SX,SY,12)
        sunG.addColorStop(0,'rgba(255,252,200,1)'); sunG.addColorStop(.5,'rgba(255,220,70,1)')
        sunG.addColorStop(1,'rgba(255,170,20,.92)')
        ctx2.beginPath(); ctx2.arc(SX,SY,12,0,Math.PI*2); ctx2.fillStyle=sunG; ctx2.fill()
        ctx2.beginPath(); ctx2.arc(SX-22,SY+8,3,0,Math.PI*2)
        ctx2.fillStyle=`rgba(255,200,80,${.15*B})`; ctx2.fill()
      }

      // CLOUDS
      const cb = 1-B
      if (cb > .04) {
        for (const c of CLOUDS) {
          c.x -= c.spd; if (c.x < -c.w*1.2) c.x = W+c.w*.5
          drawCloud(ctx2, c.x, c.y, c.w, c.h, c.alpha, cb)
        }
        if (Math.random() < .004*cb) { lightningFlash=1; lightningX=W*.2+Math.random()*W*.6 }
        if (lightningFlash > 0) {
          lightningFlash = lerp(lightningFlash, 0, .15)
          ctx2.fillStyle = `rgba(200,220,255,${lightningFlash*.12})`; ctx2.fillRect(0,0,W,skyH)
          if (lightningFlash > .5) {
            ctx2.strokeStyle=`rgba(220,235,255,${lightningFlash*.8})`; ctx2.lineWidth=1.5; ctx2.beginPath()
            let lx=lightningX,ly=0
            while(ly<skyH){ctx2.moveTo(lx,ly);lx+=(Math.random()-.5)*12;ly+=8+Math.random()*10;ctx2.lineTo(lx,ly)}
            ctx2.stroke()
          }
        }
      }

      // WATER
      const wG = ctx2.createLinearGradient(0,0,0,H)
      wG.addColorStop(0,  `rgba(${rn(lerp(22,20,B))},${rn(lerp(25,88,B))},${rn(lerp(55,130,B))},.97)`)
      wG.addColorStop(.12,`rgba(${rn(lerp(14,10,B))},${rn(lerp(16,65,B))},${rn(lerp(45,120,B))},.99)`)
      wG.addColorStop(.35,`rgba(${rn(lerp(8,5,B))},${rn(lerp(10,40,B))},${rn(lerp(35,95,B))},1)`)
      wG.addColorStop(.65,`rgba(${rn(lerp(4,3,B))},${rn(lerp(5,22,B))},${rn(lerp(22,65,B))},1)`)
      wG.addColorStop(1,'rgba(1,4,18,1)')
      ctx2.beginPath(); ctx2.moveTo(0,H); ctx2.lineTo(0,s[0])
      for(let x=1;x<W;x++) ctx2.lineTo(x,s[x])
      ctx2.lineTo(W,H); ctx2.closePath(); ctx2.fillStyle=wG; ctx2.fill()

      const depG = ctx2.createLinearGradient(0,0,0,H)
      depG.addColorStop(0,'rgba(0,0,0,.22)'); depG.addColorStop(.15,'rgba(0,0,0,0)'); depG.addColorStop(1,'rgba(0,0,0,.38)')
      ctx2.beginPath(); ctx2.moveTo(0,H); ctx2.lineTo(0,s[0])
      for(let x=1;x<W;x++) ctx2.lineTo(x,s[x])
      ctx2.lineTo(W,H); ctx2.closePath(); ctx2.fillStyle=depG; ctx2.fill()

      // Sun reflection + shafts
      if (B > .1) {
        const refG = ctx2.createLinearGradient(W*.6,0,W*.96,0)
        refG.addColorStop(0,'rgba(0,0,0,0)'); refG.addColorStop(.35,`rgba(255,200,60,${.07*B})`)
        refG.addColorStop(.5,`rgba(255,220,90,${.13*B})`); refG.addColorStop(.65,`rgba(255,200,60,${.07*B})`); refG.addColorStop(1,'rgba(0,0,0,0)')
        ctx2.beginPath(); ctx2.moveTo(0,H); ctx2.lineTo(0,s[0])
        for(let x=1;x<W;x++) ctx2.lineTo(x,s[x])
        ctx2.lineTo(W,H); ctx2.closePath(); ctx2.fillStyle=refG; ctx2.fill()
        for(let i=0;i<4;i++){
          const shX=W*.15+i*(W*.25)+Math.sin(t*.22+i)*12
          const shSY=s[Math.max(0,Math.min(W-1,Math.round(shX)))]
          const shG=ctx2.createLinearGradient(shX,shSY,shX+15,H)
          shG.addColorStop(0,`rgba(255,210,80,${(.045+.02*Math.sin(t*.35+i))*B})`)
          shG.addColorStop(.35,'rgba(140,180,255,.012)'); shG.addColorStop(1,'rgba(0,0,0,0)')
          ctx2.beginPath(); ctx2.moveTo(shX-8,shSY); ctx2.lineTo(shX+8,shSY)
          ctx2.lineTo(shX+24,H); ctx2.lineTo(shX-18,H); ctx2.closePath()
          ctx2.fillStyle=shG; ctx2.fill()
        }
      }

      // Second wave layer — amplitudes dialed back to match getY calming
      ctx2.beginPath(); ctx2.moveTo(0,H); ctx2.lineTo(0,s[0]+5)
      for(let x=1;x<W;x++) ctx2.lineTo(x,s[x]+5+Math.sin(x*.018-t*1.5)*1.9+Math.sin(x*.032+t*1.1)*1.1)
      ctx2.lineTo(W,H); ctx2.closePath()
      const l2G=ctx2.createLinearGradient(0,0,0,H*.28)
      l2G.addColorStop(0,B>.5?'rgba(60,150,200,.07)':'rgba(60,70,140,.06)'); l2G.addColorStop(1,'rgba(0,0,0,0)')
      ctx2.fillStyle=l2G; ctx2.fill()

      // RAIN
      if (B < .92) {
        const ra = 1-B
        for(const d of DROPS){
          d.y+=d.spd; d.x-=d.spd*.22
          if(d.y>H+10){d.y=-8;d.x=Math.random()*W}
          if(d.x<-10) d.x=W+10
          const xi2=Math.max(0,Math.min(W-1,Math.round(d.x)))
          if(d.y>=s[xi2]&&d.y<s[xi2]+d.spd+4){
            if(Math.random()<.35) RIPPLES.push({x:d.x,y:s[xi2],r:0,life:1,maxR:5+d.depth*8})
            d.y=-Math.random()*H; d.x=Math.random()*W
          }
          ctx2.beginPath(); ctx2.moveTo(d.x,d.y); ctx2.lineTo(d.x+d.len*.2,d.y-d.len)
          ctx2.strokeStyle=`rgba(180,200,235,${d.alpha*ra})`; ctx2.lineWidth=d.width; ctx2.stroke()
        }
        for(let i=RIPPLES.length-1;i>=0;i--){
          const rp=RIPPLES[i]; rp.r=lerp(rp.r,rp.maxR,.08)+.5; rp.life-=.04
          if(rp.life<=0){RIPPLES.splice(i,1);continue}
          ctx2.beginPath(); ctx2.ellipse(rp.x,rp.y,rp.r,rp.r*.3,0,0,Math.PI*2)
          ctx2.strokeStyle=`rgba(160,195,235,${rp.life*.25*ra})`; ctx2.lineWidth=.65; ctx2.stroke()
        }
        const mistG=ctx2.createLinearGradient(0,s[0],0,s[0]+22)
        mistG.addColorStop(0,`rgba(90,110,175,${.1*ra})`); mistG.addColorStop(1,'rgba(0,0,0,0)')
        ctx2.beginPath(); ctx2.moveTo(0,s[0]); for(let x=1;x<W;x++) ctx2.lineTo(x,s[x])
        for(let x=W-1;x>=0;x--) ctx2.lineTo(x,s[x]+22)
        ctx2.closePath(); ctx2.fillStyle=mistG; ctx2.fill()
      }

      // SHIMMER surface (no line)
      ctx2.beginPath(); ctx2.moveTo(0,s[0]); for(let x=1;x<W;x++) ctx2.lineTo(x,s[x])
      for(let x=W-1;x>=0;x--) ctx2.lineTo(x,s[x]+3+Math.sin(x*.038+t*1.8)*.9)
      ctx2.closePath()
      const shimG=ctx2.createLinearGradient(0,0,W,0)
      for(let i=0;i<=18;i++){
        const sh=B>.5?.04+.18*Math.pow(Math.abs(Math.sin(i/18*Math.PI*4+t*1.6)),2.5):.02+.08*Math.pow(Math.abs(Math.sin(i/18*Math.PI*3+t*.8)),2)
        shimG.addColorStop(i/18,B>.5?`rgba(200,235,255,${sh})`:`rgba(130,155,210,${sh})`)
      }
      ctx2.fillStyle=shimG; ctx2.fill()

      // Right-edge live price marker follows the main waterline.
      const markerX = W - 6
      const markerY = s[Math.max(0, W - 1)]
      const livePrice = prices.length ? prices[prices.length - 1] : null
      const livePriceTxt = livePrice !== null && Number.isFinite(livePrice)
        ? '$' + livePrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : '--'
      ctx2.beginPath()
      ctx2.arc(markerX, markerY, 2.7, 0, Math.PI * 2)
      ctx2.fillStyle = B > .5 ? 'rgba(205,238,255,.95)' : 'rgba(188,205,255,.95)'
      ctx2.fill()
      const badgeW = Math.max(48, livePriceTxt.length * 6.1 + 8)
      const badgeX = markerX - badgeW - 10
      const badgeY = markerY - 8
      ctx2.fillStyle = 'rgba(8,12,26,.72)'
      ctx2.strokeStyle = B > .5 ? 'rgba(186,228,255,.45)' : 'rgba(166,178,255,.42)'
      ctx2.lineWidth = 0.7
      ctx2.beginPath()
      ctx2.roundRect(badgeX, badgeY, badgeW, 14, 7)
      ctx2.fill()
      ctx2.stroke()
      ctx2.fillStyle = B > .5 ? 'rgba(214,245,255,.95)' : 'rgba(209,218,255,.94)'
      ctx2.font = '600 8.5px system-ui, sans-serif'
      ctx2.textBaseline = 'middle'
      ctx2.fillText(livePriceTxt, badgeX + 5, badgeY + 7)

      // FOAM — thin arc streaks (no circles)
      for(let x=3;x<W-3;x+=3){
        const y=s[x],yL=s[x-3]||y,yR=s[x+3]||y
        if(y<yL&&y<yR){
          const d=(yL+yR)/2-y
          if(d>1.2){
            const a=Math.min(.75,d*.22)*(.2+.8*Math.abs(Math.sin(t*6+x*.09)))
            ctx2.beginPath()
            ctx2.moveTo(x-d*1.8, y-.5)
            ctx2.quadraticCurveTo(x, y-2.5, x+d*1.8, y-.5)
            ctx2.strokeStyle=`rgba(255,255,255,${a})`; ctx2.lineWidth=0.8; ctx2.stroke()
            if(d>2.8&&Math.random()<.012*chop)
              SPRAY.push({x,y:y-2,vx:(Math.random()-.5)*2.5,vy:-(1+Math.random()*2.5),life:1,r:.8+Math.random()*.8})
          }
        }
      }
      for(let i=SPRAY.length-1;i>=0;i--){
        const p=SPRAY[i]; p.x+=p.vx; p.y+=p.vy; p.vy+=.12; p.life-=.06
        if(p.life<=0||p.y>H){SPRAY.splice(i,1);continue}
        ctx2.beginPath(); ctx2.arc(p.x,p.y,p.r*p.life,0,Math.PI*2)
        ctx2.fillStyle=`rgba(220,235,255,${p.life*.5})`; ctx2.fill()
      }

      // BOAT — spring X + spring Y
      const targetBX = W*.58
        + Math.sin(t*1.9)*18
        + Math.sin(t*1.4)*10
        + Math.sin(t*2.8)*5
      const clampBX = Math.max(W*.18, Math.min(W*.82, targetBX))
      st.boatVX += -SK*1.2*(st.boatX-clampBX) - SD*.8*st.boatVX
      st.boatX  += st.boatVX

      const xi3=Math.max(0,Math.min(W-1,Math.round(st.boatX)))
      st.boatVY += -SK*(st.boatY-s[xi3]) - SD*st.boatVY
      st.boatY  += st.boatVY

      const xL=Math.max(0,xi3-10), xR=Math.min(W-1,xi3+10)
      const rawTilt=Math.atan2(s[xR]-s[xL], xR-xL)*.5
      st.boatTiltV += -SK*1.8*(st.boatTilt-rawTilt) - SD*.85*st.boatTiltV
      st.boatTilt  += st.boatTiltV

      const bob=Math.sin(t*1.8)*.9+Math.cos(t*1.1)*.4

      // Wake
      for(let i=1;i<12;i++){
        const wx=st.boatX-i*7, wxi4=Math.max(0,Math.min(W-1,Math.round(wx)))
        const wa=(.26-i*.02)*.7
        if(wa<=0||wx<0)break
        ctx2.beginPath(); ctx2.ellipse(wx,s[wxi4]+.1,i*.85,i*.2,0,0,Math.PI*2)
        ctx2.strokeStyle=`rgba(200,225,255,${wa})`; ctx2.lineWidth=.5; ctx2.stroke()
      }

      const S=13
      ctx2.save(); ctx2.translate(st.boatX, st.boatY+bob); ctx2.rotate(st.boatTilt)

      ctx2.beginPath()
      ctx2.moveTo(-S*1.05,0)
      ctx2.bezierCurveTo(-S*1.0,S*.4,-S*.65,S*.54,0,S*.54)
      ctx2.bezierCurveTo(S*.65,S*.54,S*1.0,S*.4,S*1.05,0)
      ctx2.closePath()
      const hG=ctx2.createLinearGradient(0,-S*.05,0,S*.56)
      hG.addColorStop(0,'#9a5520'); hG.addColorStop(.45,'#5a2508'); hG.addColorStop(1,'#1e0a02')
      ctx2.fillStyle=hG; ctx2.fill()
      ctx2.strokeStyle='rgba(220,160,90,.45)'; ctx2.lineWidth=.6; ctx2.stroke()

      ctx2.beginPath(); ctx2.moveTo(-S*.82,S*.07); ctx2.quadraticCurveTo(0,-S*.08,S*.82,S*.07)
      ctx2.strokeStyle=B>.5?'rgba(255,220,120,.32)':'rgba(140,165,220,.22)'; ctx2.lineWidth=.9; ctx2.stroke()

      ctx2.beginPath(); ctx2.ellipse(0,0,S*.97,S*.14,0,0,Math.PI*2)
      const dG=ctx2.createLinearGradient(0,-S*.13,0,S*.13)
      dG.addColorStop(0,'#ddd0b0'); dG.addColorStop(1,'#a08858'); ctx2.fillStyle=dG; ctx2.fill()

      ctx2.beginPath(); ctx2.moveTo(-S*.06,S*.02); ctx2.lineTo(-S*.06,-S*2.12)
      ctx2.strokeStyle='#241202'; ctx2.lineWidth=2.4; ctx2.stroke()
      ctx2.beginPath(); ctx2.moveTo(-S*.06,-S*.12); ctx2.lineTo(S*.9,-S*.12)
      ctx2.strokeStyle='#2e1604'; ctx2.lineWidth=1.2; ctx2.stroke()

      ctx2.strokeStyle='rgba(80,60,30,.55)'; ctx2.lineWidth=.6
      ctx2.beginPath(); ctx2.moveTo(-S*.06,-S*2.08); ctx2.lineTo(-S*1.0,.02); ctx2.stroke()
      ctx2.beginPath(); ctx2.moveTo(-S*.06,-S*2.08); ctx2.lineTo(S*.95,.02);  ctx2.stroke()
      ctx2.beginPath(); ctx2.moveTo(-S*.06,-S*1.2);  ctx2.lineTo(-S*.85,.02); ctx2.stroke()
      ctx2.beginPath(); ctx2.moveTo(-S*.06,-S*1.2);  ctx2.lineTo(S*.85,.02);  ctx2.stroke()

      ctx2.beginPath()
      ctx2.moveTo(-S*.05,-S*.12)
      ctx2.bezierCurveTo(S*.35,-S*.2,S*.85,-S*.28,S*.9,-S*.32)
      ctx2.lineTo(-S*.05,-S*2.06); ctx2.closePath()
      const sailG=ctx2.createLinearGradient(-S*.05,-S*2.1,S*.9,-S*.32)
      const sa=B>.5?.97:.82
      sailG.addColorStop(0,`rgba(255,254,250,${sa})`)
      sailG.addColorStop(.6,`rgba(240,235,225,${sa-.06})`)
      sailG.addColorStop(1,`rgba(228,220,208,${sa-.1})`)
      ctx2.fillStyle=sailG; ctx2.fill()
      ctx2.strokeStyle='rgba(170,160,145,.18)'; ctx2.lineWidth=.4; ctx2.stroke()

      ctx2.beginPath(); ctx2.moveTo(-S*.05,-S*.86); ctx2.lineTo(-S*.05,-S*1.96); ctx2.lineTo(-S*.82,-S*.2); ctx2.closePath()
      ctx2.fillStyle=`rgba(250,246,238,${sa-.05})`; ctx2.fill()

      ctx2.beginPath(); ctx2.moveTo(-S*.05,-S*2.1); ctx2.lineTo(S*.2,-S*1.9); ctx2.lineTo(-S*.05,-S*1.74); ctx2.closePath()
      ctx2.fillStyle='#7B2CFF'; ctx2.shadowBlur=8; ctx2.shadowColor='rgba(123,44,255,.9)'; ctx2.fill(); ctx2.shadowBlur=0

      ctx2.beginPath(); ctx2.arc(S*.9,.04,1.8,0,Math.PI*2)
      ctx2.fillStyle='rgba(100,220,130,.7)'; ctx2.fill()

      // Treasury chest + premium gold details.
      const chestX = S * .34
      const chestY = -S * .42
      const chestW = S * .66
      const chestH = S * .36
      const chestLid = S * .18

      ctx2.beginPath()
      ctx2.moveTo(chestX, chestY)
      ctx2.lineTo(chestX + chestW, chestY)
      ctx2.lineTo(chestX + chestW, chestY + chestH)
      ctx2.lineTo(chestX, chestY + chestH)
      ctx2.closePath()
      const chestBodyG = ctx2.createLinearGradient(chestX, chestY, chestX, chestY + chestH)
      chestBodyG.addColorStop(0, 'rgba(84,36,12,.98)')
      chestBodyG.addColorStop(.55, 'rgba(52,20,6,.97)')
      chestBodyG.addColorStop(1, 'rgba(28,10,4,.95)')
      ctx2.fillStyle = chestBodyG
      ctx2.fill()
      ctx2.strokeStyle = 'rgba(225,168,92,.38)'
      ctx2.lineWidth = .55
      ctx2.stroke()

      ctx2.beginPath()
      ctx2.ellipse(chestX + chestW * .5, chestY - chestLid * .14, chestW * .52, chestLid, 0, Math.PI, Math.PI * 2)
      const chestLidG = ctx2.createLinearGradient(chestX, chestY - chestLid, chestX, chestY + 1)
      chestLidG.addColorStop(0, 'rgba(112,52,18,.97)')
      chestLidG.addColorStop(1, 'rgba(54,20,8,.95)')
      ctx2.fillStyle = chestLidG
      ctx2.fill()
      ctx2.strokeStyle = 'rgba(245,184,112,.36)'
      ctx2.stroke()

      for (const coin of DECK_COINS) {
        const tw = .58 + .42 * Math.sin(t * 3.2 + coin.p)
        const rr = coin.r * (0.9 + tw * .18)
        ctx2.beginPath()
        ctx2.arc(chestX + coin.x, chestY + coin.y, rr, 0, Math.PI * 2)
        const coinG = ctx2.createRadialGradient(chestX + coin.x - .3, chestY + coin.y - .3, .1, chestX + coin.x, chestY + coin.y, rr)
        coinG.addColorStop(0, `rgba(255,247,188,${.95 * tw})`)
        coinG.addColorStop(.55, `rgba(244,200,76,${.82 * tw})`)
        coinG.addColorStop(1, `rgba(186,128,34,${.78 * tw})`)
        ctx2.fillStyle = coinG
        ctx2.fill()

        if (tw > .92) {
          ctx2.beginPath()
          ctx2.moveTo(chestX + coin.x - 1.2, chestY + coin.y)
          ctx2.lineTo(chestX + coin.x + 1.2, chestY + coin.y)
          ctx2.moveTo(chestX + coin.x, chestY + coin.y - 1.2)
          ctx2.lineTo(chestX + coin.x, chestY + coin.y + 1.2)
          ctx2.strokeStyle = `rgba(255,244,186,${(tw - .9) * 2.5})`
          ctx2.lineWidth = .35
          ctx2.stroke()
        }
      }

      if (t > nextCoinDropT && FALLING_COINS.length < 4 && Math.random() < .05) {
        const localX = chestX + chestW * .78
        const localY = chestY - chestLid * .22
        const ct = Math.cos(st.boatTilt)
        const stn = Math.sin(st.boatTilt)
        FALLING_COINS.push({
          x: st.boatX + localX * ct - localY * stn,
          y: st.boatY + bob + localX * stn + localY * ct,
          vx: st.boatVX * .06 + .25 + Math.random() * .35,
          vy: -(.6 + Math.random() * .4),
          life: 1,
          spin: Math.random() * Math.PI * 2,
          size: .9 + Math.random() * .7,
        })
        nextCoinDropT = t + 2.8 + Math.random() * 2.6
      }

      ctx2.restore()

      for (let i = FALLING_COINS.length - 1; i >= 0; i--) {
        const c = FALLING_COINS[i]
        c.x += c.vx
        c.y += c.vy
        c.vy += .048
        c.spin += .18
        c.life -= .013
        const xi = Math.max(0, Math.min(W - 1, Math.round(c.x)))
        if (c.life <= 0 || c.y > s[xi] + 12) {
          FALLING_COINS.splice(i, 1)
          continue
        }
        const a = Math.max(0, c.life * .85)
        const stretch = .55 + .45 * Math.abs(Math.sin(c.spin))
        ctx2.beginPath()
        ctx2.ellipse(c.x, c.y, c.size * stretch, c.size * .72, c.spin, 0, Math.PI * 2)
        ctx2.fillStyle = `rgba(245,196,70,${a})`
        ctx2.fill()
        if (Math.sin(c.spin * 1.7) > .84) {
          ctx2.beginPath()
          ctx2.arc(c.x, c.y, c.size * .35, 0, Math.PI * 2)
          ctx2.fillStyle = `rgba(255,245,196,${a * .75})`
          ctx2.fill()
        }
      }
    }

    draw()
    return () => {
      cancelAnimationFrame(animRef.current)
      window.removeEventListener('resize', resize)
      ro.disconnect()
    }

  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'block',
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    />
  )
}
