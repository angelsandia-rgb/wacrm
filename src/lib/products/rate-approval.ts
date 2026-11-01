import type { ProductRate } from './rates'

/** Keep disputed prices stored for audit, without letting them become an automatic quote. */
export function hasPendingSeasonRates(description: string | null | undefined): boolean {
  const text = (description ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  return text.includes('tarifas de temporada alta pendientes de confirmacion del hotel')
}
export function markPendingSeasonRates<T extends ProductRate>(rates: T[], description: string | null | undefined): T[] {
  if (!hasPendingSeasonRates(description)) return rates
  return rates.map(rate => rate.date_from && rate.date_to ? { ...rate, requires_confirmation: true } : rate)
}
