export interface AttentionContext {
  customerText?: string | null
  staffText?: string | null
}

const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const compact = (s: string) => s.replace(/\s+/g, ' ').trim()
const acknowledgement = (s: string) => /^(gracias|muchas gracias|si|ok|muy bien|perfecto|entendido)[.!\s]*$/.test(normalize(s).trim())

function classify(text: string): { reason: string; action: string } | null {
  const t = normalize(text)
  if (/\b(?:no|aun no|todavia no)\b.{0,20}\b(?:me reserve|me reserven|reservar|confirmar la reserva)\b/.test(t))
    return { reason: 'su indicación de no reservar todavía.', action: 'Respetar su decisión y aclarar sus dudas antes de confirmar una reserva.' }
  if (/\b(?:olvid|quedo|perdi|guardar|guarden|recoger)\w*\b/.test(t) && /\b(?:almohada|objeto|lentes|ropa|cargador|pertenencia|habitacion)\w*\b/.test(t))
    return { reason: 'un objeto olvidado en el hotel.', action: 'Verificar si está resguardado y coordinar su devolución.' }
  if (/\b(?:factur\w*|nit)\b/.test(t))
    return { reason: 'una solicitud o seguimiento de facturación.', action: 'Revisar los datos fiscales y responder sobre la factura pendiente.' }
  if (/\b(?:no me cuadra|no cuadra|importe incorrecto|cobro incorrecto|diferencia de precio)\b/.test(t))
    return { reason: 'una diferencia en el precio o la cotización.', action: 'Revisar el cálculo y aclarar el importe con el cliente.' }
  if (/\b(?:cancel\w*|anular|reembols\w*|devolucion de dinero)\b/.test(t))
    return { reason: 'una solicitud de cancelación o devolución.', action: 'Evaluar la solicitud y confirmar al cliente qué es posible realizar.' }
  if (/\b(?:cambiar|cambios?|modificar|mover|reducir|aumentar|reprogram\w*|reagend\w*)\b/.test(t) && /\b(?:reserva|fechas|habitaciones|cotizacion|cantidad\w*)\b/.test(t))
    return { reason: 'un cambio solicitado en una reserva o cotización.', action: 'Revisar el cambio solicitado; no darlo por realizado antes de aprobarlo.' }
  if (/\b(?:comprobante|boleta|adjunto pago|adjunto deposito|ya pague|ya pagamos|deposite|transferi|envio el pago)\b/.test(t))
    return { reason: 'la verificación de un comprobante de pago.', action: 'Revisar el comprobante y confirmar al cliente si el pago fue acreditado.' }
  if (/\b(?:verificar|revisar|validar) (?:el |un )?pago\b/.test(t))
    return { reason: 'la verificación de un pago.', action: 'Verificar el pago y comunicar el resultado al cliente.' }
  if (/\b(?:pago|pagar|tarjeta|banco)\b/.test(t) && /\b(?:no permitio|rechaz|fallo|validacion|no puedo|no pude|error)\w*\b/.test(t))
    return { reason: 'una dificultad para realizar el pago.', action: 'Revisar el problema y facilitar una alternativa de pago autorizada.' }
  if (/\b(?:pago|pagar|anticipo|deposito|cuenta bancaria|link de pago)\b/.test(t))
    return { reason: 'la coordinación de un pago.', action: 'Indicar el medio de pago autorizado y resolver la consulta del cliente.' }
  if (/\b(?:masaje\w*|spa|terapia)\b/.test(t) && /\b(?:junt\w*|horario\w*|hora\w*|agend\w*|turno\w*|disponib\w*)\b/.test(t))
    return { reason: 'la coordinación de horarios de masaje o spa.', action: 'Verificar los horarios disponibles y confirmar la opción solicitada.' }
  if (/\b(?:numero de habitacion|llave|acceso|no funciona|no hay agua|cerradura)\b/.test(t))
    return { reason: 'asistencia durante su estancia.', action: 'Coordinar la atención con recepción y responder al huésped.' }
  if (/\b(?:restaurante|desayuno|almuerzo|cena|pedido)\b/.test(t))
    return { reason: 'una consulta o pedido del restaurante.', action: 'Confirmar con restaurante el servicio solicitado y orientar al huésped.' }
  if (/\b(?:disponibilidad|me confirma|nos confirma|confirmar la reserva|confirmar disponibilidad|queda reservad\w*|reservar)\b/.test(t))
    return { reason: 'la confirmación de una solicitud de reserva.', action: 'Verificar disponibilidad y total antes de confirmar la reserva al cliente.' }
  if (/\b(?:cotiz\w*|precio\w*|tarifa\w*|total\w*|presupuesto|cuanto cuesta)\b/.test(t))
    return { reason: 'una cotización o un cálculo de precio pendiente.', action: 'Revisar las opciones y responder con los importes autorizados.' }
  if (/\b(?:persona|humano|asesor|recepcionista)\b/.test(t) && /\b(?:hablar|atencion|comunicar|contactar)\b/.test(t))
    return { reason: 'atención directa de una persona del hotel.', action: 'Abrir el chat y continuar la atención solicitada.' }
  return null
}

/** Reasons describe the request, never an unverified outcome or image contents. */
export function explainAttention(summary: string, last: string | null | undefined, context: AttentionContext = {}): { reason: string; action: string } {
  if (/complet[oó] y confirm[oó] su solicitud/i.test(summary))
    return { reason: 'una solicitud completa que necesita confirmación del hotel.', action: 'Confirmar disponibilidad y total; el huésped ya completó su solicitud.' }
  const direct = last && !acknowledgement(last) ? classify(last) : null
  if (direct) return direct
  const current = context.customerText ? classify(context.customerText) : null
  if (current) return current
  const recordedReason = summary.match(/Motivo:\s*[“"]([\s\S]*?)[”"](?:\s|$)/i)?.[1]
  const recorded = classify(recordedReason || summary.split('\n')[0])
  if (recorded) return recorded
  // A short answer can depend on the hotel's immediately preceding question.
  if (last && (acknowledgement(last) || compact(last).length < 70)) {
    const staff = context.staffText ? classify(context.staffText) : null
    if (staff) return staff
    if (context.staffText && /\b(?:fecha|entrada|salida|nombre|apellido|personas|adultos|edades|noches)\b/.test(normalize(context.staffText)))
      return { reason: 'datos recibidos para continuar una solicitud del hotel.', action: 'Revisar los datos proporcionados y continuar la atención del cliente.' }
  }
  if (/archivo|foto|imagen|documento|nota de voz/i.test([last, recordedReason, context.customerText].filter(Boolean).join(' ')))
    return { reason: 'un archivo adjunto que requiere revisión.', action: 'Revisar el archivo y su contexto; confirmar al cliente el siguiente paso.' }
  return { reason: 'una consulta pendiente que debe revisar el equipo.', action: 'Leer el mensaje y el contexto del chat para responder al cliente.' }
}

/** Full detail stays in the panel; the push renderer gives reason/action priority. */
export function attentionBody(summary: string, request?: string | null, lastMessage?: string | null, context: AttentionContext = {}): string {
  const last = lastMessage || summary.match(/Último mensaje del cliente:\s*[“"]([\s\S]*?)[”"]/i)?.[1]
  const { reason, action } = explainAttention(summary, last, context)
  return [`Cliente necesita atención por: ${reason}`, `Acción requerida: ${action}`,
    request ? `Referencia registrada: ${compact(request.replace(/^[-\s]+/, ''))}` : null,
    last ? `Último mensaje: «${compact(last)}»` : null,
    context.customerText && compact(context.customerText) !== compact(last || '') ? `Contexto del cliente: ${compact(context.customerText)}` : null,
    context.staffText ? `Última indicación del hotel: ${compact(context.staffText)}` : null,
    'Plazo: máximo 2 horas en horario del hotel (8:00 a. m.–8:00 p. m.); de noche, al iniciar ese horario.',
    '', 'Contexto completo:', summary].filter(v => v !== null).join('\n')
}
