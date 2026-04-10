'use client'
import { useEffect, useRef } from 'react'

interface GameCanvasProps {
  pnlPct: number
  currentPrice: number
  priceHistory: number[]
}

export default function GameCanvas({ pnlPct, currentPrice, priceHistory }: GameCanvasProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<any>(null)

  useEffect(() => {
    if (!mountRef.current) return

    let animId: number
    let THREE: any

    async function init() {
      // Dynamic import to avoid SSR
      THREE = await import('three').then(m => m)

      const mount = mountRef.current!
      const W = mount.clientWidth
      const H = mount.clientHeight

      // Renderer
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
      renderer.setSize(W, H)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setClearColor(0x030310)
      mount.appendChild(renderer.domElement)

      // Scene
      const scene = new THREE.Scene()
      scene.fog = new THREE.FogExp2(0x030310, 0.035)

      // Camera
      const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 200)
      camera.position.set(0, 8, 18)
      camera.lookAt(0, 0, 0)

      // Lights
      const ambient = new THREE.AmbientLight(0x1a1aff, 0.3)
      scene.add(ambient)

      const dirLight = new THREE.DirectionalLight(0x7b2cff, 1.5)
      dirLight.position.set(5, 10, 5)
      scene.add(dirLight)

      const rimLight = new THREE.DirectionalLight(0x1a1aff, 2)
      rimLight.position.set(-5, 2, -10)
      scene.add(rimLight)

      // Ocean plane
      const GRID = 80
      const SIZE = 40
      const geo = new THREE.PlaneGeometry(SIZE, SIZE, GRID, GRID)
      geo.rotateX(-Math.PI / 2)
      const posAttr = geo.attributes.position

      const mat = new THREE.MeshStandardMaterial({
        color: 0x050530,
        metalness: 0.9,
        roughness: 0.1,
        wireframe: false,
      })
      const ocean = new THREE.Mesh(geo, mat)
      scene.add(ocean)

      // Price line (glowing)
      const lineGeo = new THREE.BufferGeometry()
      const linePoints = new Float32Array(60 * 3)
      lineGeo.setAttribute('position', new THREE.BufferAttribute(linePoints, 3))
      const lineMat = new THREE.LineBasicMaterial({ color: 0x7df2a8, linewidth: 2 })
      const priceLine = new THREE.Line(lineGeo, lineMat)
      priceLine.position.y = 0.5
      scene.add(priceLine)

      // Stars
      const starGeo = new THREE.BufferGeometry()
      const starVerts = new Float32Array(3000)
      for (let i = 0; i < 3000; i += 3) {
        starVerts[i]     = (Math.random() - 0.5) * 200
        starVerts[i + 1] = Math.random() * 80 + 5
        starVerts[i + 2] = (Math.random() - 0.5) * 200
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(starVerts, 3))
      const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.15, transparent: true, opacity: 0.6 })
      scene.add(new THREE.Points(starGeo, starMat))

      sceneRef.current = { renderer, scene, camera, ocean, priceLine, posAttr }

      // Resize handler
      const onResize = () => {
        const w = mount.clientWidth
        const h = mount.clientHeight
        camera.aspect = w / h
        camera.updateProjectionMatrix()
        renderer.setSize(w, h)
      }
      window.addEventListener('resize', onResize)

      let t = 0

      function animate() {
        animId = requestAnimationFrame(animate)
        t += 0.008

        // Animate ocean vertices
        const pos = posAttr
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i)
          const z = pos.getZ(i)
          const wave =
            Math.sin(x * 0.5 + t * 1.2) * 0.4 +
            Math.sin(z * 0.4 + t * 0.9) * 0.3 +
            Math.sin((x + z) * 0.3 + t * 1.5) * 0.2
          pos.setY(i, wave)
        }
        pos.needsUpdate = true
        ocean.geometry.computeVertexNormals()

        // Subtle camera drift
        camera.position.x = Math.sin(t * 0.1) * 1.5
        camera.position.y = 8 + Math.sin(t * 0.15) * 0.5
        camera.lookAt(0, 0, 0)

        // Update ocean color based on PnL
        const isPos = pnlPct >= 0
        const targetColor = isPos ? 0x051a20 : 0x1a0510
        mat.color.lerp(new THREE.Color(targetColor), 0.02)
        const lineColor = isPos ? 0x7df2a8 : 0xff7c98
        ;(lineMat as any).color.lerp(new THREE.Color(lineColor), 0.05)

        renderer.render(scene, camera)
      }

      animate()

      return () => {
        window.removeEventListener('resize', onResize)
        cancelAnimationFrame(animId)
        renderer.dispose()
        if (mount.contains(renderer.domElement)) {
          mount.removeChild(renderer.domElement)
        }
      }
    }

    const cleanup = init()
    return () => {
      cancelAnimationFrame(animId)
      cleanup.then(fn => fn?.())
    }
  }, [])

  // Update price line when history changes
  useEffect(() => {
    if (!sceneRef.current || priceHistory.length < 2) return
    const { priceLine } = sceneRef.current
    const positions = priceLine.geometry.attributes.position
    const n = Math.min(priceHistory.length, 60)
    const minP = Math.min(...priceHistory)
    const maxP = Math.max(...priceHistory)
    const range = maxP - minP || 1

    for (let i = 0; i < 60; i++) {
      const idx = Math.floor((i / 60) * n)
      const price = priceHistory[idx] ?? priceHistory[priceHistory.length - 1]
      const x = (i / 59) * 30 - 15
      const y = ((price - minP) / range) * 3 - 1.5
      positions.setXYZ(i, x, y, 0)
    }
    positions.needsUpdate = true
  }, [priceHistory])

  return <div ref={mountRef} style={{ width: '100%', height: '100%', position: 'absolute', inset: 0 }} />
}
