import type { SupabaseClient } from '@supabase/supabase-js'
import { runAutomationsForTrigger } from './engine'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

// ============================================================
// Domain events that fan out to both outbound webhooks and the
// automation triggers of the same name (respond.io parity). Writes made
// BY an automation never re-fire automations — the chain would loop
// (an automation that closes on close, or updates a field on update).
// ============================================================

export type CloseSource = 'human' | 'ai_action' | 'automation' | 'auto_close'

/** A conversation just moved to `closed`. Never throws. */
export async function notifyConversationClosed(
  db: SupabaseClient,
  input: { accountId: string; conversationId: string; closedBy: CloseSource },
): Promise<void> {
  try {
    void dispatchWebhookEvent(db, input.accountId, 'conversation.closed', {
      conversation_id: input.conversationId,
      closed_by: input.closedBy,
    })
    if (input.closedBy === 'automation') return
    const { data: conv } = await db
      .from('conversations')
      .select('contact_id')
      .eq('id', input.conversationId)
      .eq('account_id', input.accountId)
      .maybeSingle()
    await runAutomationsForTrigger({
      accountId: input.accountId,
      triggerType: 'conversation_closed',
      contactId: (conv?.contact_id as string | undefined) ?? null,
      context: { conversation_id: input.conversationId },
    })
  } catch (err) {
    console.error('[automations] notifyConversationClosed failed:', err)
  }
}

/** Contact fields that actually changed value — built-in columns by name,
 *  custom fields as `custom:<id>`. Never throws. */
export async function notifyContactFieldsUpdated(input: {
  accountId: string
  contactId: string
  fields: string[]
}): Promise<void> {
  for (const field of input.fields) {
    await runAutomationsForTrigger({
      accountId: input.accountId,
      triggerType: 'contact_field_updated',
      contactId: input.contactId,
      context: { field },
    }).catch((err) => console.error('[automations] contact_field_updated failed:', err))
  }
}
