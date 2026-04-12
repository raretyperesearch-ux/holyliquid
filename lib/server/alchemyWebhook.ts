// lib/server/alchemyWebhook.ts
// Helper for registering deposit addresses with an Alchemy webhook so
// Alchemy fires POST /api/deposit/webhook whenever USDC lands on that address.

const ALCHEMY_UPDATE_WEBHOOK_URL = 'https://dashboard.alchemy.com/api/update-webhook-addresses'

export class AlchemyWebhookRegistrationError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'AlchemyWebhookRegistrationError'
  }
}

function isHexAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value)
}

export async function addAddressToAlchemyWebhook(address: string): Promise<void> {
  const webhookId = process.env.ALCHEMY_WEBHOOK_ID
  const authToken = process.env.ALCHEMY_WEBHOOK_AUTH_TOKEN || process.env.ALCHEMY_API_KEY
  const normalizedAddress = address.toLowerCase()

  if (!isHexAddress(address)) {
    throw new AlchemyWebhookRegistrationError('Invalid EVM address', { address })
  }

  if (!webhookId) {
    throw new AlchemyWebhookRegistrationError('Missing ALCHEMY_WEBHOOK_ID')
  }

  if (!authToken) {
    throw new AlchemyWebhookRegistrationError(
      'Missing Alchemy auth token (set ALCHEMY_WEBHOOK_AUTH_TOKEN)'
    )
  }

  if (!process.env.ALCHEMY_WEBHOOK_AUTH_TOKEN && process.env.ALCHEMY_API_KEY) {
    console.warn(
      '[ALCHEMY] Using ALCHEMY_API_KEY as fallback webhook auth token. Prefer ALCHEMY_WEBHOOK_AUTH_TOKEN.'
    )
  }

  const res = await fetch(ALCHEMY_UPDATE_WEBHOOK_URL, {
    method: 'PATCH',
    headers: { 'X-Alchemy-Token': authToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webhook_id: webhookId,
      addresses_to_add: [normalizedAddress],
      addresses_to_remove: [],
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new AlchemyWebhookRegistrationError('Alchemy webhook update failed', {
      status: res.status,
      webhookId,
      address: normalizedAddress,
      response: body.slice(0, 500),
    })
  }
}
