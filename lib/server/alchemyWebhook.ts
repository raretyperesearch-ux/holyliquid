// lib/server/alchemyWebhook.ts
// Helper for registering deposit addresses with an Alchemy webhook so
// Alchemy fires POST /api/deposit/webhook whenever USDC lands on that address.
//
// Called once per new HD-derived deposit address at provisioning time.

export async function addAddressToAlchemyWebhook(address: string): Promise<void> {
  const webhookId = process.env.ALCHEMY_WEBHOOK_ID
  const apiKey = process.env.ALCHEMY_API_KEY
  if (!webhookId || !apiKey) throw new Error('Alchemy env not set')

  const res = await fetch('https://dashboard.alchemy.com/api/update-webhook-addresses', {
    method: 'PATCH',
    headers: { 'X-Alchemy-Token': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webhook_id: webhookId,
      addresses_to_add: [address.toLowerCase()],
      addresses_to_remove: [],
    }),
  })
  if (!res.ok) throw new Error(`Alchemy webhook update failed: ${await res.text()}`)
}
