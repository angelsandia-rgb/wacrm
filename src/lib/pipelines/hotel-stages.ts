/** Hotel stages deliberately separate guest intent from hotel approval. */
export function hotelStageKind(name?: string | null): 'quote' | 'pending' | 'confirmed' | 'discard' | null {
  const n = (name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
  if (n === 'descarte') return 'discard'
  if (n === 'cotizando') return 'quote'
  if (n === 'pendiente de confirmacion') return 'pending'
  if (n === 'visita confirmada') return 'confirmed'
  return null
}

export function reservationStageKind(status: string, guestConfirmedAt?: string | null) {
  if (status === 'approved') return 'confirmed'
  if (status === 'denied') return 'discard'
  return guestConfirmedAt ? 'pending' : 'quote'
}

export function hotelStageDescription(name?: string | null): string | null {
  switch (hotelStageKind(name)) {
    case 'quote': return 'Consulta y estimado en curso.'
    case 'pending': return 'Solicitud enviada; falta confirmar disponibilidad y total.'
    case 'confirmed': return 'El hotel confirmó la visita.'
    case 'discard': return 'Sin compra. No cancela ni modifica una reserva.'
    default: return null
  }
}
