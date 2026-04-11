import { Position, Pair } from './types'
import { randomUUID } from 'crypto'

const SUPPORTED_PAIRS: Pair[] = ['ETH/USD', 'BTC/USD', 'SOL/USD']
const DEFAULT_ACTIVE_PAIRS: Pair[] = ['ETH/USD']
const LEVERAGES           = [50, 75, 100] as const

function getActivePairs(): Pair[] {
  const raw = process.env.HL_ACTIVE_PAIRS?.trim()
  if (!raw) return DEFAULT_ACTIVE_PAIRS

  const parsed = raw
    .split(',')
    .map(v => v.trim().toUpperCase())
    .filter((v): v is Pair => SUPPORTED_PAIRS.includes(v as Pair))

  return parsed.length ? parsed : DEFAULT_ACTIVE_PAIRS
}

export function generatePosition(): Position {
  const activePairs = getActivePairs()
  return {
    pair:      activePairs[Math.floor(Math.random() * activePairs.length)],
    direction: Math.random() > 0.5 ? 'long' : 'short',
    size:      Math.floor(Math.random() * 900_000) + 100_000,
    leverage:  LEVERAGES[Math.floor(Math.random() * LEVERAGES.length)],
  }
}

export function calcLiqPrice(position: Position, openPrice: number): number {
  const move = 1 / position.leverage
  return position.direction === 'long'
    ? openPrice * (1 - move)
    : openPrice * (1 + move)
}

export function generateSeed(): string {
  return randomUUID()
}
