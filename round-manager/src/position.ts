import { Position, Pair } from './types'
import { randomUUID } from 'crypto'

const PAIRS: Pair[]       = ['ETH/USD', 'BTC/USD', 'SOL/USD']
const LEVERAGES           = [50, 75, 100] as const

export function generatePosition(): Position {
  return {
    pair:      PAIRS[Math.floor(Math.random() * PAIRS.length)],
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
