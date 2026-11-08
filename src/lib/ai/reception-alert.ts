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
  return /^(?:(?:muchas|muchisimas|mil) )?gracias(?: (?:muy amable|le agradezco|buenas noches|buen dia))?(?: por (?:la informacion|su atencion|todo))?$/.test(clean)
    || /^muy bien(?: (?:licenciada|licenciado|gracias))?$/.test(clean)
    || /^(?:muy amable|que amable|se lo agradezco|le agradezco|muchas gracias muy amable)(?: por (?:la informacion|su atencion|todo))?$/.test(clean)
    || /^(?:perfecto gracias )?yo les escribo en unos dias$/.test(clean)
    || /^muy bien (?:en (?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) les comento que decidimos gracias|yo les informo con gusto)$/.test(clean)
}

const DECLINE_RE = /\b(?:(?:en|para) otra (?:ocasion|oportunidad)|ya (?:encontramos|conseguimos|reservamos) (?:otro|otra|en otro)|(?:buscaremos|buscamos|tuvimos que buscar) otra opcion)\b/

/** The customer closed the thread: thanks last, and anything before it only
 *  declines (VSR 2026-11-07: "vamos a ir en otra ocasión…" + "muy amable por
 *  la información" still got a "Pendiente de recepción" note at 20:01). A
 *  question before the thanks still counts as pending. */
export function isCustomerClosing(turns: string[]): boolean {
  if (!turns.length || !isCourtesyClosing(turns[turns.length - 1])) return false
  return turns.slice(0, -1).every((t) => isCourtesyClosing(t)
    || (!t.includes('?') && DECLINE_RE.test(t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase())))
}

export function hasNewReceptionRequest(previousAt?: string | null, customerAt?: string | null): boolean {
  const previous = Date.parse(previousAt ?? '')
  const customer = Date.parse(customerAt ?? '')
  return Number.isFinite(previous) && Number.isFinite(customer) && customer > previous
}
