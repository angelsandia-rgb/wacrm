import type { ChatMessage } from './types'

export function latestCustomerTimestamp(messages: ChatMessage[]): string | null {
  const last = messages.findLast(m => m.role === 'user')
  // An acknowledgement alone does not create a new task for reception.
  if (last && isSimpleAcknowledgement(last.content)) return null
  return last?.createdAt ?? null
}

export function isSimpleAcknowledgement(text: string): boolean {
  return isCourtesyClosing(text) || /^(si|ok|okay|perfecto|entendido|de acuerdo)[.!\s]*$/i.test(text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim())
}

/** Courtesy only: never swallow a yes/acceptance, a question or a new task. */
export function isCourtesyClosing(text: string): boolean {
  const clean = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Component}]/gu, '').replace(/[.,!;:\s]+/g, ' ').trim()
  return /^(?:(?:muchas|muchisimas|mil) )?gracias(?: (?:muy amable|le agradezco|buenas noches|buen dia))?$/.test(clean)
    || /^muy bien(?: (?:licenciada|licenciado|gracias))?$/.test(clean)
    || /^(?:perfecto gracias )?yo les escribo en unos dias$/.test(clean)
    || /^muy bien (?:en (?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) les comento que decidimos gracias|yo les informo con gusto)$/.test(clean)
}

export function hasNewReceptionRequest(previousAt?: string | null, customerAt?: string | null): boolean {
  const previous = Date.parse(previousAt ?? '')
  const customer = Date.parse(customerAt ?? '')
  return Number.isFinite(previous) && Number.isFinite(customer) && customer > previous
}
