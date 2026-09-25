import type { ChatMessage } from './types'

/**
 * The text to retrieve knowledge against: the most recent customer
 * (`user`) turn in the conversation context. Falls back to the last
 * message of any role, then empty string. Shared by the draft route and
 * the auto-reply bot so both query the knowledge base the same way.
 */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return messages.length > 0 ? messages[messages.length - 1].content : ''
}

/** The bot's last reply before the latest customer turn, or '' if none. */
export function previousAssistantMessage(messages: ChatMessage[]): string {
  let i = messages.length - 1
  while (i >= 0 && messages[i].role !== 'user') i--
  for (; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i].content
  }
  return ''
}

/** Up to `limit` customer turns before the latest one, newest first. */
export function earlierUserMessages(messages: ChatMessage[], limit: number): string[] {
  const out: string[] = []
  let skippedLatest = false
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    if (messages[i].role !== 'user') continue
    if (!skippedLatest) {
      skippedLatest = true
      continue
    }
    out.push(messages[i].content)
  }
  return out
}
