import { hotelStayOperationReason } from './hotel-stay-operations'
import type { ChatMessage } from './types'
import { isExplicitHumanRequest, isGiftVoucherAsk, isSpecialRateTalk } from './hotel-media-intent'

const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const OPERATIONAL = /\b(cancel\w*|reembols\w*|devol\w*|pago\w*|pagar|deposit\w*|anticipo|comprobante|factura|cotiz\w*|voucher|cupon|certificado|tour operador|toperador|tarifa especial|precio especial|clientes? frecuentes?|corporativ\w*|mi reserva|nuestra reserva|confirm\w*|reprogram\w*|reagend\w*|no entiendo|no entendi|no comprendo|i don.t understand|refund|cancel|payment|invoice|quote)\b/
const INFORMATION = /\b(precios?|tarifas?|cuanto|cuesta[n]?|comparar|referencias?|horarios?|a que hora|check.?in|check.?out|desayun\w*|almuerz\w*|cena\w*|parqueo|wifi|wi.fi|mascotas?|piscina|gimnasio|jacuzzi|ubicacion|direccion|como lleg\w*|fotos?|fotograf\w*|imagenes?|menu|breakfast|parking|photos?|directions|amenities)\b/
const TOTAL_QUESTION = /\b(?:como|cuanto|cual|que)\b[^.!?\n]{0,60}\btotal(?:es)?\b/
const NEW_INQUIRY = /\b(hospedaje|alojamiento|habitacion\w*|suite|paquete|masaje|spa|stay|room)\b/

export const HOTEL_RECEPTION_PENDING_PREFIX = '🤝 Pendiente de recepción.'

export const HOTEL_FAMILY_LODGING_POLICY = 'FAMILY LODGING PRIORITY: Headcount alone, including more than six guests or several rooms, does not make an inquiry a group/event quotation. Continue ordinary family lodging intake. Use dates and child ages already provided; clarify alternative adult counts such as six or seven and the desired room distribution before estimating. Offer suitable room combinations only from approved rates and published capacities. The hotel confirms availability and the final price within the authorized window. Negotiated group rates, corporate agreements, events, payments and existing booking/quote changes still follow their reception rules. Do not reopen an already handed-off message without a new customer inbound.'

/** Only application-created reception notes qualify; manual takeovers use a different summary. */
export function isHotelReceptionPending(summary: string | null | undefined): boolean {
  return summary?.startsWith(HOTEL_RECEPTION_PENDING_PREFIX) ?? false
}

/** Route only messages received after an already-recorded handoff. Keep the
 * full transcript for generation so existing staff agreements remain visible. */
export function hotelCurrentRequest(messages: ChatMessage[], handoffAt?: string | null): ChatMessage[] {
  const since = handoffAt ? Date.parse(handoffAt) : NaN
  if (!Number.isFinite(since)) return messages
  const start = messages.findIndex((m) => m.role === 'user' && m.createdAt && Date.parse(m.createdAt) > since)
  if (start < 0) return messages
  // Silent staff decisions do not add an assistant turn. A later, separate
  // customer burst still needs to become eligible for a new factual topic.
  let burstStart = start
  for (let i = messages.length - 1; i > start; i--) {
    if (messages[i - 1].role !== 'user') { burstStart = i; break }
    const gap = Date.parse(messages[i].createdAt ?? '') - Date.parse(messages[i - 1].createdAt ?? '')
    if (gap > 3 * 60_000) { burstStart = i; break }
  }
  return messages.slice(burstStart)
}

/** A hotel operation requiring a staff decision, rather than public information. */
export function hotelReceptionReason(messages: ChatMessage[]): string | null {
  const stayOperation = hotelStayOperationReason(messages)
  if (stayOperation) return stayOperation
  const trailing: string[] = []
  for (let i = messages.length - 1; i >= 0 && messages[i].role === 'user'; i--) trailing.unshift(messages[i].content)
  const text = normalize(trailing.join(' '))
  if (isExplicitHumanRequest(text)) return 'El cliente solicita atención de una persona.'
  // A follow-up needs a staff decision, even when the last line is a greeting
  // or thanks. Ordinary first-time availability inquiries remain eligible.
  if (/\bdisponibilidad\b/.test(text) && /\b(falta que|sigo esperando|seguimos esperando|quedo pendiente|validar|validen|ya estaran|aun no|todavia no|me confirmen|nos confirmen)\b/.test(text)) return 'Recepción debe responder la confirmación de disponibilidad pendiente.'
  if (/\b(ya no (?:vamos a )?(?:usar|necesitar|utilizar)|reducir|reducimos|distribucion quedara)\b/.test(text)
    && /\b(habitaciones?|dobles?|sencillas?|huespedes)\b/.test(text)) return 'Recepción debe revisar un cambio en las habitaciones del grupo.'
  if (/\b(le[s]? comparto|le[s]? envio)\b/.test(text) && /\b(menu|pedido)\b/.test(text)
    && /\b(grupo de hoy|almuerzos? de hoy|para hoy)\b/.test(text)) return 'Restaurante debe confirmar el pedido enviado para hoy.'
  if (isGiftVoucherAsk(text)) return 'Recepción debe validar el voucher o certificado.'
  if (isSpecialRateTalk([text])) return 'Recepción debe revisar una tarifa especial o un convenio.'
  if (/\b(numero de cuenta|cuenta bancaria|datos bancarios|link de pago|enlace de pago|comprobante|boleta|ya pague|ya pagamos|deposite|transferi|quiero pagar|necesito pagar|pagar el anticipo|hacer el deposito|bank account|payment receipt)\b/.test(text)) return 'Recepción debe coordinar o verificar un pago.'
  const policyOnly = /\b(politicas?|condiciones|plazo|antelacion|policy)\b/.test(text)
    && !/\b(mi reserva|nuestra reserva|ya pague|mi pago|my booking)\b/.test(text)
  if (!policyOnly && /\b(cancel\w*|reembols\w*|devolucion|refund|cancell?ation)\b/.test(text)) return 'Recepción debe revisar una cancelación o devolución.'
  if (/\b(reprogram\w*|reagend\w*)\b/.test(text)
    || (/\b(cambiar|modificar|mover|cambio)\b/.test(text) && /\b(mi reserva|nuestra reserva|la reserva|mi reservacion|my booking)\b/.test(text))) return 'Recepción debe revisar un cambio de reserva.'
  if (/\b(mi factura|necesito (?:una |la )?factura|envie\w* (?:la |mi )?factura|factura a nombre|my invoice)\b/.test(text)) return 'Recepción debe revisar la facturación solicitada.'
  if (/\b(ya (?:llene|complete|envie|llenamos|completamos) el formulario|mi cotizacion|nuestra cotizacion|la cotizacion|mi reserva esta confirmada|confirmad[oa] mi|estado de mi reserva)\b/.test(text)) return 'El cliente da seguimiento a una gestión pendiente del hotel.'
  // A family needing several rooms is ordinary lodging intake. Headcount
  // alone is not a request for negotiated group rates or event services.
  const group = /\b(eventos?|bodas?|salon|delegacion|excursion|empresas?|corporativ\w*|corporate|wedding|event)\b/.test(text)
    || /\b(?:tarifas?|precios?|descuentos?|cotiz\w*|presupuesto)\s+(?:especial(?:es)?\s+)?(?:para |de )?(?:un |el |nuestro )?grupos?\b|\bgroup\s+(?:rates?|discounts?|quotes?)\b|\btarifas?\s+grupal(?:es)?\b/.test(text)
  if (group && /\b(cotiz\w*|presupuesto|precio\w*|tarifa\w*|cuanto|quote|prices?|rates?|discounts?)\b/.test(text)) return 'Recepción debe preparar la cotización de grupo o evento.'
  return null
}

/** Reclassification must not replay a customer request already left to reception. */
export function isAlreadyHandedOffRequest(messages: ChatMessage[], handoffAt?: string | null): boolean {
  const handedOff = Date.parse(handoffAt ?? '')
  const latest = messages.findLast(m => m.role === 'user')?.createdAt
  const received = Date.parse(latest ?? '')
  return Number.isFinite(handedOff) && Number.isFinite(received) && received <= handedOff
}

/** After the three-hour window, staff business stays with staff. Only
 * factual information (or an unmistakable new inquiry with no open request)
 * may resume automatically. A bare yes, guest count or confusion is not one. */
export function shouldDeferHotelStaffFollowup(messages: ChatMessage[], hasActiveRequest: boolean, context: ChatMessage[] = messages): boolean {
  if (hotelStayOperationReason(messages)) return true
  const trailing: string[] = []
  for (let i = messages.length - 1; i >= 0 && messages[i].role === 'user'; i--) trailing.unshift(messages[i].content)
  const text = normalize(trailing.join(' '))
  if (OPERATIONAL.test(text)) return true
  if (answersHotelIntakeQuestion(messages, context)) return false
  if (INFORMATION.test(text) || TOTAL_QUESTION.test(text)) return false
  if (!hasActiveRequest && NEW_INQUIRY.test(text)) return false
  return true
}

/** Recognize a guest supplying intake data requested by the bot. Staff
 * questions and operational decisions retain their own handoff rules. */
export function answersHotelIntakeQuestion(messages: ChatMessage[], context: ChatMessage[] = messages): boolean {
  const latestIndex = context.findLastIndex(m => m.role === 'user')
  const last = context[latestIndex]
  const question = context.slice(0, latestIndex).findLast(m => m.role === 'assistant')
  if (!last || !question || question.senderType === 'agent' || !/[?¿]/.test(question.content)) return false
  const gap = Date.parse(last.createdAt ?? '') - Date.parse(question.createdAt ?? '')
  if (Number.isFinite(gap) && (gap < 0 || gap > 24 * 60 * 60_000)) return false
  const trailing: string[] = []
  for (let i = messages.length - 1; i >= 0 && messages[i].role === 'user'; i--) trailing.unshift(messages[i].content)
  const text = normalize(trailing.join(' '))
  if (OPERATIONAL.test(text) || hotelReceptionReason(messages)) return false
  const ask = normalize(question.content)
  const dateAnswer = /\b(?:hoy|manana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b|\b\d{1,4}[\/-]\d{1,2}|\b\d{1,2}\s*(?:de\s+)?(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/.test(text)
  if (/\b(?:fecha|dia|entrada|ingres\w*|salida|lleg\w*)\b/.test(ask) && dateAnswer) return true
  if (/\b(?:noches|duracion|tiempo|dias)\b/.test(ask) && /\b(?:\d+|un[ao]?|dos|tres|cuatro|cinco)\s+(?:noches?|dias?)\b/.test(text)) return true
  if (/\b(?:personas|adultos|ninos|edades|huespedes)\b/.test(ask) && /\b(?:\d+|uno|una|dos|tres|cuatro|cinco|seis|siete)\b/.test(text)) return true
  if (/\b(?:habitacion|suite|opcion)\b/.test(ask) && /\b(?:junior|premium|master|clasica|doble|sencilla|individual|primera|segunda)\b/.test(text)) return true
  if (/\b(?:nombre|titular|apellido)\b/.test(ask) && /^[a-z\s'-]{3,100}$/.test(text.trim())) return true
  return false
}

/** Detect a stated arrival with no explicit departure, interval or length.
 * Prevents turning “alojamiento para el domingo 18” into an invented night. */
export function hasUnconfirmedStayDuration(messages: ChatMessage[]): boolean {
  // Ignore dates from earlier bookings once the guest states a new arrival.
  let start = 0
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user' && /\b(?:alojamiento|hospedaje|estadia|estancia|entrada|ingreso|llegada|llego|llegamos|check.?in|arrival|stay)\b/.test(normalize(messages[i].content))) start = i
  }
  const current = messages.slice(start)
  const users = current.filter((m) => m.role === 'user').map((m) => normalize(m.content))
  const dates = users.join(' ')
  const explicit = /\b(?:\d+|una|un|dos|tres|one|two|three)\s+(?:noches?|nights?)\b|\b(?:salida|check.?out|departure)\b|\b(?:del|desde|from)\s+.{0,35}\b(?:al|hasta|to)\s+\d|\b(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+(?:a|al|hasta)\s+(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(dates)
  if (explicit) return false
  // A guest may confirm the dates in the bot's explicit question.
  for (let i = 1; i < current.length; i++) {
    if (current[i].role === 'user' && /^(si|ok|correcto|confirmo|yes|correct)\b/.test(normalize(current[i].content).trim())
      && current[i - 1].role === 'assistant' && /[?¿]/.test(current[i - 1].content)
      && /salida|check.?out|departure/i.test(current[i - 1].content)) return false
  }
  return /\b(?:alojamiento|hospedaje|estadia|estancia|entrada|ingreso|llegada|llego|llegamos|check.?in|arrival|stay)\b/.test(dates)
    && /\d{1,2}|lunes|martes|miercoles|jueves|viernes|sabado|domingo/.test(dates)
}
