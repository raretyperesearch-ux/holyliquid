// scripts/generate-hd-seed.ts
// ONE-TIME USE: Generate a master HD seed for HolyLiquid deposit addresses.
//
// Run: npx tsx scripts/generate-hd-seed.ts
//
// Then:
//   1. Copy the mnemonic to a piece of PAPER
//   2. Add it to Vercel env vars as DEPOSIT_HD_SEED (production + preview + dev)
//   3. Add it to .env.local for local development
//   4. CLEAR YOUR TERMINAL: `clear` or `cmd+k`
//   5. Delete this script: rm scripts/generate-hd-seed.ts
//   6. NEVER paste this seed anywhere else

import { Wallet } from 'ethers'

const wallet = Wallet.createRandom()
console.log('\n══════════════════════════════════════════════════')
console.log('  HOLYLIQUID DEPOSIT HD SEED — STORE SAFELY')
console.log('══════════════════════════════════════════════════\n')
console.log('Mnemonic (12 words):')
console.log(`\n  ${wallet.mnemonic?.phrase}\n`)
console.log('First derived address (sanity check, m/44\'/60\'/0\'/0/0):')
console.log(`  ${wallet.address}\n`)
console.log('══════════════════════════════════════════════════')
console.log('  NEXT STEPS:')
console.log('  1. Write the 12 words on PAPER')
console.log('  2. Add DEPOSIT_HD_SEED to Vercel + .env.local')
console.log('  3. Clear your terminal (cmd+k or `clear`)')
console.log('  4. Delete this script: rm scripts/generate-hd-seed.ts')
console.log('══════════════════════════════════════════════════\n')
