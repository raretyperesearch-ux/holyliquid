import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  eslint: {
    ignoreDuringBuilds: true,  // lint errors won't block deploy
  },
  typescript: {
    ignoreBuildErrors: false,  // keep TS errors blocking (important for correctness)
  },
}

export default nextConfig
