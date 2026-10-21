import type { ChatMessage } from './types'

export function latestCustomerTimestamp(messages: ChatMessage[]): string | null {
  const last = messages.findLast(m => m.role === 'user')
  // An acknowledgement alone does not create a new task for reception.
  if (last && isSimpleAcknowledgement(last.content)) return null
  return last?.createdAt ?? null
}

export function isSimpleAcknowledgement(text: string): boolean {
  return /^(si|ok|okay|gracias|muchas gracias|perfecto|entendido|de acuerdo)[.!\s]*$/i.test(text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim())
}

export function hasNewReceptionRequest(previousAt?: string | null, customerAt?: string | null): boolean {
  const previous = Date.parse(previousAt ?? '')
  const customer = Date.parse(customerAt ?? '')
  return Number.isFinite(previous) && Number.isFinite(customer) && customer > previous
}
