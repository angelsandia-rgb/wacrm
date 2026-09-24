// ============================================================
// Pure helpers for the hotel bot's single warm CLOSE (see the CLOSING
// protocol in defaults.ts). Live test run 2026-09-24 (Villa San
// Ricardo, 18 chats) showed the model, with every field already known:
//  - ending its reply with a permission question ("¿Desea que le deje
//    registrada la solicitud…?") in about half the closes, and
//  - writing "Queda anotado…" but forgetting the confirm marker, so the
//    team was never told.
// These let the code enforce the close deterministically instead of
// hoping the model follows the prompt.
// ============================================================

/** A trailing question that only asks permission to register / confirm /
 *  book what is already complete — never one that asks for information. */
const PERMISSION_QUESTION_RE =
  /¿\s*(?:le\s+gustar[ií]a|desea|quiere|gusta|le\s+parece|me\s+permite|puedo|lo|la)\b[^?¿]*\b(?:dej(?:e|o|emos|arla|arlo|ársela|ársel[oa])|registr\w*|anot\w*|reserv\w*|confirm\w*|apart\w*|agend\w*|proceder|avanz\w*|lista|listo|conect\w*|comuni\w*)\b[^?¿]*\?\s*$/i

/**
 * When `text` ends in a permission-only question, returns the text
 * without it (trimmed). Returns null when the ending is anything else —
 * a real question for missing data, or no question at all.
 */
export function stripTrailingPermissionQuestion(text: string): string | null {
  const trimmed = text.trimEnd()
  const match = trimmed.match(PERMISSION_QUESTION_RE)
  if (!match || match.index === undefined) return null
  const before = trimmed.slice(0, match.index).trimEnd()
  return before
}

const CLOSE_LINES = [
  'Queda registrada su solicitud; en breve nuestro equipo le escribe para confirmarle disponibilidad y el total. 😊',
  '¡Listo! Su solicitud ya está con nuestro equipo, que le escribirá en breve para confirmarle disponibilidad y el total.',
  'Ya quedó registrada; nuestro equipo le contactará muy pronto para confirmarle disponibilidad y el total. 🙌',
]

/** A warm, varied close line to replace a stripped permission question. */
export function closeLine(variant: number): string {
  return CLOSE_LINES[Math.abs(variant) % CLOSE_LINES.length]
}

/**
 * Quetzal/dollar amounts written in a reply ("Q1,160", "GTQ 1,500",
 * "Q.300", "$120"). Small numbers (< 100) are ignored — minutes, people
 * and times aren't prices.
 */
export function mentionedAmounts(text: string): number[] {
  const out: number[] = []
  const re = /(?:GTQ|Q\.?|\$|USD)\s?(\d{1,3}(?:[,.]\d{3})+|\d+)(?:[.,]\d{1,2})?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1].replace(/[,.]/g, ''))
    if (Number.isFinite(n) && n >= 100) out.push(n)
  }
  return out
}

/** Some amount in `text` that is neither the real total nor its deposit. */
export function hasConflictingAmount(text: string, total: number, deposit: number): boolean {
  return mentionedAmounts(text).some((n) => n !== Math.round(total) && n !== Math.round(deposit))
}

/** A YYYY-MM-DD date strictly before today's YYYY-MM-DD (string compare). */
export function isPastDate(dateISO: string | null | undefined, todayISO: string | null | undefined): boolean {
  return Boolean(dateISO && todayISO && dateISO < todayISO)
}
