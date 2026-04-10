'use client'
import { useEffect, useRef } from 'react'

interface Props {
  waterLevel: number
  onWaterPct: (pct: number) => void
  priceHistory: number[]  // live price points, up to 60
}

export default function GameCanvas({ waterLevel, onWaterPct, priceHistory }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef({
    curWL: 0,
    targWL: waterLevel,
    prices: priceHistory,
  })

  useEffect(() => {
    stateRef.current.targWL = waterLevel
  }, [waterLevel])

  useEffect(() => {
    stateRef.current.prices = priceHistory
  }, [priceHistory])

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const root = cv.parentElement!
    const CW = root.clientWidth || 390
    const CH = root.clientHeight || 720
    let animId: number

    async function init() {
      const THREE = await import('three')

      cv!.width = CW * devicePixelRatio
      cv!.height = CH * devicePixelRatio
      cv!.style.cssText = `position:absolute;inset:0;width:${CW}px;height:${CH}px`

      const renderer = new THREE.WebGLRenderer({ canvas: cv!, antialias: true, alpha: false })
      renderer.setSize(CW, CH)
      renderer.setPixelRatio(devicePixelRatio)
      renderer.setClearColor(0x05050a, 1)

      const scene = new THREE.Scene()
      scene.fog = new THREE.Fog(0x05050a, 18, 40)

      const cam = new THREE.PerspectiveCamera(52, CW / CH, 0.1, 60)
      cam.position.set(0, 1.2, 10)
      cam.lookAt(0, -1, 0)

      // Background
      const bgMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(40, 22),
        new THREE.MeshBasicMaterial({ color: 0x070911 })
      )
      bgMesh.position.set(0, 2, -18)
      scene.add(bgMesh)

      const gBlue = new THREE.Mesh(
        new THREE.SphereGeometry(4, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0x1A1AFF, transparent: true, opacity: 0.1 })
      )
      gBlue.position.set(-5, 5, -12)
      scene.add(gBlue)

      const gPurp = new THREE.Mesh(
        new THREE.SphereGeometry(3.5, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0x7B2CFF, transparent: true, opacity: 0.09 })
      )
      gPurp.position.set(6, 4, -14)
      scene.add(gPurp)

      // Stars
      const sp = new Float32Array(150 * 3)
      for (let i = 0; i < 150; i++) {
        sp[i*3]   = (Math.random() - 0.5) * 30
        sp[i*3+1] = Math.random() * 12 + 1
        sp[i*3+2] = (Math.random() - 0.5) * 14 - 4
      }
      const sg = new THREE.BufferGeometry()
      sg.setAttribute('position', new THREE.BufferAttribute(sp, 3))
      scene.add(new THREE.Points(sg, new THREE.PointsMaterial({
        color: 0xffffff, size: 0.055, sizeAttenuation: true, transparent: true, opacity: 0.4
      })))

      // ── PRICE CHART WATER SURFACE ──────────────────────────────
      // N columns, each col has top vertex (chart) and bottom vertex (sea floor)
      // Forms a filled water shape that follows live price history
      const N = 60
      const X_START = -8, X_END = 8, Y_FLOOR = -4

      // 2 triangles per column segment = (N-1) * 2 * 3 indices
      const chartVerts = new Float32Array(N * 2 * 3)  // N top + N bottom vertices (x,y,z)
      const chartIdx: number[] = []

      // Init positions
      for (let i = 0; i < N; i++) {
        const x = X_START + (i / (N - 1)) * (X_END - X_START)
        // top vertex
        chartVerts[i * 3 + 0] = x
        chartVerts[i * 3 + 1] = 0
        chartVerts[i * 3 + 2] = 0
        // bottom vertex
        chartVerts[(N + i) * 3 + 0] = x
        chartVerts[(N + i) * 3 + 1] = Y_FLOOR
        chartVerts[(N + i) * 3 + 2] = 0
      }

      // Triangles: quad per column segment
      for (let i = 0; i < N - 1; i++) {
        const tl = i,     tr = i + 1
        const bl = N + i, br = N + i + 1
        chartIdx.push(tl, bl, tr, tr, bl, br)
      }

      const chartGeo = new THREE.BufferGeometry()
      const chartPos = new THREE.BufferAttribute(chartVerts, 3)
      chartPos.setUsage(THREE.DynamicDrawUsage)
      chartGeo.setAttribute('position', chartPos)
      chartGeo.setIndex(chartIdx)
      chartGeo.computeVertexNormals()

      const chartMat = new THREE.MeshBasicMaterial({
        color: 0x1a2aff,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
      })
      const chartMesh = new THREE.Mesh(chartGeo, chartMat)
      chartMesh.position.z = -0.5
      scene.add(chartMesh)

      // Glowing price line on top of water surface
      const lineVerts = new Float32Array(N * 3)
      const lineGeo = new THREE.BufferGeometry()
      const linePos = new THREE.BufferAttribute(lineVerts, 3)
      linePos.setUsage(THREE.DynamicDrawUsage)
      lineGeo.setAttribute('position', linePos)
      const lineMat = new THREE.LineBasicMaterial({ color: 0x7df2a8, linewidth: 2 })
      const priceLine = new THREE.Line(lineGeo, lineMat)
      priceLine.position.z = -0.4
      scene.add(priceLine)

      // ── BOAT (scaled down) ────────────────────────────────────
      const boatGrp = new THREE.Group()
      const hs = new THREE.Shape()
      hs.moveTo(-1.15, .02)
      hs.bezierCurveTo(-1.12, -.06, -1.05, -.18, -.9, -.22)
      hs.bezierCurveTo(-.45, -.32, .4, -.30, .86, -.18)
      hs.bezierCurveTo(1.0, -.1, 1.08, .0, 1.12, .1)
      hs.lineTo(1.06, .34)
      hs.bezierCurveTo(.45, .38, -.45, .34, -1.0, .28)
      hs.closePath()

      const hGeo = new THREE.ExtrudeGeometry(hs, { depth: .7, bevelEnabled: true, bevelThickness: .025, bevelSize: .02, bevelSegments: 2 })
      hGeo.translate(0, 0, -.35)
      boatGrp.add(new THREE.Mesh(hGeo, new THREE.MeshStandardMaterial({ color: 0x6B3D18, roughness: .8, metalness: .06 })))

      const deck = new THREE.Mesh(new THREE.BoxGeometry(2.3, .04, .74), new THREE.MeshStandardMaterial({ color: 0xDDD8CC, roughness: .9 }))
      deck.position.set(0, .02, 0); boatGrp.add(deck)

      const planks = new THREE.Mesh(new THREE.BoxGeometry(2.08, .055, .63), new THREE.MeshStandardMaterial({ color: 0xC0804A, roughness: .85 }))
      planks.position.set(0, .27, 0); boatGrp.add(planks)

      const mast = new THREE.Mesh(new THREE.CylinderGeometry(.022, .03, 2.4, 8), new THREE.MeshStandardMaterial({ color: 0x3E2008, roughness: .75 }))
      mast.position.set(-.06, 1.52, 0); boatGrp.add(mast)

      const sv = new Float32Array([-.06, .28, .02, -.06, 2.38, .02, 1.04, .46, .02])
      const sGeo = new THREE.BufferGeometry(); sGeo.setAttribute('position', new THREE.BufferAttribute(sv, 3)); sGeo.setIndex([0,2,1,0,1,2]); sGeo.computeVertexNormals()
      boatGrp.add(new THREE.Mesh(sGeo, new THREE.MeshStandardMaterial({ color: 0xFFFAF2, side: THREE.DoubleSide, roughness: .82, transparent: true, opacity: .92 })))

      const jv = new Float32Array([-.06, 1.1, .02, -.06, 2.36, .02, -1.02, .32, .02])
      const jGeo = new THREE.BufferGeometry(); jGeo.setAttribute('position', new THREE.BufferAttribute(jv, 3)); jGeo.setIndex([0,2,1,0,1,2]); jGeo.computeVertexNormals()
      boatGrp.add(new THREE.Mesh(jGeo, new THREE.MeshStandardMaterial({ color: 0xF5F0E8, side: THREE.DoubleSide, roughness: .84, transparent: true, opacity: .88 })))

      const flag = new THREE.Mesh(new THREE.BoxGeometry(.2, .1, .02), new THREE.MeshStandardMaterial({ color: 0x7B2CFF }))
      flag.position.set(.05, 2.58, 0); boatGrp.add(flag)

      const silMat = new THREE.MeshStandardMaterial({ color: 0x0f1520, roughness: 1 })
      const body = new THREE.Mesh(new THREE.CylinderGeometry(.08, .1, .25, 8), silMat); body.position.set(-.55, .52, 0); boatGrp.add(body)
      const head = new THREE.Mesh(new THREE.SphereGeometry(.095, 10, 10), silMat); head.position.set(-.54, .7, 0); boatGrp.add(head)
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(.18, .18, .03, 12), silMat); brim.position.set(-.54, .79, 0); boatGrp.add(brim)
      const tophat = new THREE.Mesh(new THREE.CylinderGeometry(.09, .11, .12, 12), silMat); tophat.position.set(-.54, .86, 0); boatGrp.add(tophat)
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(.012, .017, 1.4, 6), new THREE.MeshStandardMaterial({ color: 0x7B5B14, roughness: .65 }))
      rod.rotation.z = -Math.PI / 2.5; rod.position.set(.18, .9, 0); boatGrp.add(rod)

      // ← SMALLER BOAT: scale down to 55%
      boatGrp.scale.set(0.55, 0.55, 0.55)
      boatGrp.position.set(X_END, 0, 0)  // starts at rightmost (current price)
      boatGrp.rotation.y = 0.1
      scene.add(boatGrp)

      scene.add(new THREE.AmbientLight(0xffffff, .65))
      const dl1 = new THREE.DirectionalLight(0x9090ff, 1.0); dl1.position.set(-3, 8, 4); scene.add(dl1)
      const dl2 = new THREE.DirectionalLight(0x6644ff, .5); dl2.position.set(4, 3, -2); scene.add(dl2)

      // Helper: map price history to Y world positions
      function getPriceYs(prices: number[]): number[] {
        if (prices.length < 2) return new Array(N).fill(0)
        const minP = Math.min(...prices)
        const maxP = Math.max(...prices)
        const range = maxP - minP || 1
        // Map to Y range -2 to 2
        return prices.map(p => ((p - minP) / range) * 3 - 1.5)
      }

      // Update chart mesh and line with price data
      function updateChart(prices: number[]) {
        const ys = getPriceYs(prices)
        const n = ys.length
        if (n < 2) return

        const pos = chartGeo.attributes.position as import("three").BufferAttribute
        const lpos = lineGeo.attributes.position as import("three").BufferAttribute

        for (let i = 0; i < N; i++) {
          const dataIdx = Math.floor((i / (N - 1)) * (n - 1))
          const y = ys[Math.min(dataIdx, n - 1)]
          const x = X_START + (i / (N - 1)) * (X_END - X_START)

          // top vertex (chart surface)
          pos.setXYZ(i, x, y, 0)
          // bottom vertex (sea floor)
          pos.setXYZ(N + i, x, Y_FLOOR, 0)
          // line vertex
          lpos.setXYZ(i, x, y, 0)
        }

        pos.needsUpdate = true
        lpos.needsUpdate = true
        chartGeo.computeVertexNormals()

        // Boat rides rightmost price point
        const lastY = ys[n - 1]
        boatGrp.position.x = X_END - 0.3
        stateRef.current.targWL = lastY

        // Line color: green if trending up, red if down
        const trend = ys[n - 1] > ys[0]
        ;(lineMat as any).color.set(trend ? 0x7df2a8 : 0xff7c98)
        ;(chartMat as any).color.set(trend ? 0x0a3a2a : 0x3a0a1a)
      }

      function syncWater(curWL: number) {
        const wv = new THREE.Vector3(0, curWL, 0)
        wv.project(cam)
        const pct = (1 + wv.y) / 2 * 100
        onWaterPct(Math.max(5, Math.min(92, pct)))
      }

      function animate() {
        animId = requestAnimationFrame(animate)
        const t = Date.now() * 0.001
        const state = stateRef.current

        // Update chart from live price data
        if (state.prices.length >= 2) {
          updateChart(state.prices)
        }

        state.curWL += (state.targWL - state.curWL) * 0.025

        // Boat bobs on chart surface
        const wh = Math.sin(.15 * .6 + t * 2.1) * .08 + Math.sin(-.2 * .5 + t * 1.65) * .05
        boatGrp.position.y = state.curWL + wh
        boatGrp.rotation.z = Math.sin(t * 1.3) * .022 + Math.cos(t * .85) * .015

        syncWater(state.curWL)
        renderer.render(scene, cam)
      }

      animate()
    }

    init()
    return () => { cancelAnimationFrame(animId) }
  }, [])

  return <canvas ref={canvasRef} className="hl-canvas" />
}
