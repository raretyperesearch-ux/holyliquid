// RULES — do not violate these during implementation
// 1. Touch oracle and round-manager ONLY. Nothing else exists yet.
// 2. Round manager owns reality. Frontend, API, client — all bend to it.
// 3. Run simulation.ts (1,000 rounds) before any UI. Fix all drift first.

import 'dotenv/config'
import { connectSupabase } from './db'
import { connectOracle } from './oracle'
import { resolveOrphanedRounds } from './recover'
import { gameLoop } from './loop'
import { startHealthServer } from './health'
import { startBotRebalancer } from './bots'
import { startLpRebalancer } from './lp'
import { startDepositSweeper } from './depositSweeper'

async function main() {
  console.log('[HolyLiquid] Starting round manager...')

  await connectSupabase()
  console.log('[HolyLiquid] ✓ Supabase connected')

  await connectOracle()
  console.log('[HolyLiquid] ✓ Oracle connected, prices live')

  await resolveOrphanedRounds()
  console.log('[HolyLiquid] ✓ Orphaned rounds resolved')

  startHealthServer()
  console.log('[HolyLiquid] ✓ Health server running on :3001')

  console.log('[HolyLiquid] All systems ready. Starting game loop.')
  startLpRebalancer()
  startBotRebalancer()
  startDepositSweeper()
  await gameLoop()
}

main().catch(err => {
  console.error('[HolyLiquid] Fatal error:', err)
  process.exit(1)
})
