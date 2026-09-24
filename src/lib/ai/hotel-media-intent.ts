// ============================================================
// Pure helpers deciding which images the hotel bot sends on its own —
// the media side of the flow is code-driven because the model does not
// reliably emit its send markers (see auto-reply.ts's banner comment).
//
//  - `productAskedAbout`: the ONE catalog item a guest's message points
//    at ("¿tiene fotos de la habitación deluxe?" → "Suite Master
//    Deluxe"), or null when it's ambiguous or absent — never a guess
//    between several.
//  - `isPhotoPromise`: whether the bot's own reply text actually PROMISES
//    a photo ("le comparto la foto de…"), as opposed to a conditional
//    offer or a question ("si me confirma, le envío la foto").
// ============================================================

/** Words shared by many items (room/package/service vocabulary, tiers,
 *  stop words) — never enough on their own to identify one product. */
const GENERIC_TOKENS = new Set([
  'suite', 'suites', 'habitacion', 'habitaciones', 'cuarto', 'cuartos', 'room',
  'paquete', 'paquetes', 'package', 'masaje', 'masajes', 'spa', 'tour', 'tours',
  'actividad', 'actividades', 'evento', 'eventos', 'salon', 'plan', 'planes',
  'noche', 'noches', 'persona', 'personas', 'pareja', 'parejas', 'individual',
  'doble', 'sencilla', 'triple', 'cuadruple', 'familiar', 'estandar', 'standard',
  'para', 'con', 'sin', 'del', 'las', 'los', 'una', 'uno', 'unos', 'unas',
  'the', 'and', 'incluye', 'servicio', 'servicios', 'opcion', 'tipo',
])

/** Lowercase, accents stripped, parenthesized notes dropped, punctuation → spaces. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const tokensOf = (text: string) => normalizeForMatch(text).split(' ').filter(Boolean)

/**
 * The single product a guest's message names or clearly points at, or
 * null. Full-name mentions win (the longest one, so "Suite Master
 * Deluxe" beats "Suite Deluxe" when both are present); otherwise a
 * distinctive word ("deluxe", "romántico") that belongs to exactly one
 * product. Two or more candidates → null (the bot asks which one).
 */
export function productAskedAbout(
  message: string,
  productNames: readonly string[],
  /** The business's own name: its words never identify a product on
   *  their own ("Paquete San Ricardo" vs. "Hotel San Ricardo"). */
  businessName?: string | null,
): string | null {
  const ignored = new Set(tokensOf(businessName ?? ''))
  const text = ` ${normalizeForMatch(message)} `
  if (!text.trim()) return null

  const byName = productNames
    .map((name) => ({ name, norm: normalizeForMatch(name) }))
    .filter((p) => p.norm.length >= 4)

  const full = byName.filter((p) => text.includes(` ${p.norm} `))
  if (full.length > 0) {
    const longest = Math.max(...full.map((p) => p.norm.length))
    const top = full.filter((p) => p.norm.length === longest)
    // A shorter full match contained in the longest one is the same mention.
    const distinct = full.filter((p) => !top.some((t) => t !== p && t.norm.includes(p.norm)))
    if (top.length !== 1 || distinct.length !== 1) return null
    // A more specific variant with the same name start ("Suite Clásica"
    // vs. "Suite Clásica Doble") that the guest did NOT name → ambiguous.
    const hasUnnamedVariant = byName.some(
      (p) => p !== top[0] && p.norm.startsWith(`${top[0].norm} `) && !text.includes(` ${p.norm} `),
    )
    return hasUnnamedVariant ? null : top[0].name
  }

  // Distinctive words: in exactly one product's name, and not generic.
  const owners = new Map<string, Set<string>>()
  for (const p of byName) {
    for (const token of new Set(tokensOf(p.name))) {
      if (token.length < 4 || GENERIC_TOKENS.has(token) || ignored.has(token) || /^\d+$/.test(token)) continue
      const set = owners.get(token) ?? new Set<string>()
      set.add(p.name)
      owners.set(token, set)
    }
  }
  const hits = new Set<string>()
  for (const token of new Set(tokensOf(message))) {
    const set = owners.get(token)
    if (set && set.size === 1) hits.add([...set][0])
  }
  return hits.size === 1 ? [...hits][0] : null
}

const PROMISE_RE =
  /\b(comparto|env[ií]o|le env[ií]o|aqu[ií]\s+tiene|aqu[ií]\s+est[aá]|le dejo)\b[^.!?\n]{0,25}\b(foto|imagen|fotograf[ií]a)/i
/** "si me confirma", "si gusta", "si lo desea", "cuando me confirme"… */
const CONDITIONAL_RE =
  /\b(si\s+(me\s+)?(confirma|gusta|desea|lo\s+desea|quiere|prefiere|le\s+parece|le\s+interesa)|cuando\s+me\s+(confirme|diga|indique)|en\s+cuanto\s+me\s+confirme)\b/i

/**
 * True only when some sentence of `reply` promises a photo outright.
 * A sentence that asks something ("¿le envío la foto?") or makes the
 * photo conditional ("si me confirma, le envío la foto") is an offer,
 * not a promise — sending the photo anyway contradicts the text the
 * guest just read (real incident 2026-09-24, Villa San Ricardo).
 */
export function isPhotoPromise(reply: string): boolean {
  const sentences = reply.match(/[^.!?\n]*[.!?\n]?/g) ?? []
  return sentences.some((sentence) => {
    if (!PROMISE_RE.test(sentence)) return false
    if (sentence.trim().endsWith('?') || sentence.includes('¿')) return false
    return !CONDITIONAL_RE.test(sentence)
  })
}
