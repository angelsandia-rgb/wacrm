import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// decrypt is identity in tests so we don't depend on real ciphertext,
// except for the sentinel `BROKEN` which simulates a mismatched
// ENCRYPTION_KEY.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => {
    if (v === 'BROKEN') throw new Error('bad decrypt')
    return `plain:${v}`
  },
}))

import { loadAiConfig } from './config'
import { AiError } from './types'

function dbReturning(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  }
  return chain as unknown as SupabaseClient
}

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  auto_schedule_appointments_enabled: false,
  ask_customer_tax_info: false,
  embeddings_api_key: null,
}

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(dbReturning(ROW), 'acct')).toBeNull()
  })

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    })
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('openai')
    expect(config!.apiKey).toBe('plain:enc-key')
  })

  it('returns null when there is no row', async () => {
    expect(
      await loadAiConfig(dbReturning(null), 'acct', { requireActive: false }),
    ).toBeNull()
  })

  it('throws AiError("invalid_key") when the stored chat key will not decrypt', async () => {
    const row = { ...ROW, api_key: 'BROKEN', is_active: true, auto_reply_enabled: true }
    await expect(
      loadAiConfig(dbReturning(row), 'acct', { requireActive: false }),
    ).rejects.toMatchObject({ code: 'invalid_key' })
    await expect(
      loadAiConfig(dbReturning(row), 'acct', { requireActive: false }),
    ).rejects.toBeInstanceOf(AiError)
  })

  it('a broken EMBEDDINGS key only disables semantic search — the config still loads', async () => {
    const row = {
      ...ROW,
      is_active: true,
      auto_reply_enabled: true,
      embeddings_api_key: 'BROKEN',
    }
    const config = await loadAiConfig(dbReturning(row), 'acct', { requireActive: false })
    expect(config).not.toBeNull()
    expect(config!.apiKey).toBe('plain:enc-key')
    expect(config!.embeddingsApiKey).toBeNull()
  })
})
