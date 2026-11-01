// Composer "AI prompts" (respond.io parity): rewrite the agent's own
// draft — tone, grammar, simplify, translate — before it is sent.

export const REWRITE_ACTIONS = [
  'professional',
  'friendly',
  'fix',
  'simplify',
  'translate_en',
  'translate_es',
] as const
export type RewriteAction = (typeof REWRITE_ACTIONS)[number]

export const MAX_REWRITE_CHARS = 4000

const INSTRUCTIONS: Record<RewriteAction, string> = {
  professional: 'Reescribe el mensaje con un tono más profesional y cortés, en el mismo idioma.',
  friendly: 'Reescribe el mensaje con un tono más cálido y amable, en el mismo idioma.',
  fix: 'Corrige ortografía, gramática y puntuación sin cambiar el tono ni el contenido, en el mismo idioma.',
  simplify: 'Reescribe el mensaje más corto y fácil de entender, en el mismo idioma.',
  translate_en: 'Traduce el mensaje al inglés.',
  translate_es: 'Traduce el mensaje al español.',
}

export function isRewriteAction(v: unknown): v is RewriteAction {
  return typeof v === 'string' && (REWRITE_ACTIONS as readonly string[]).includes(v)
}

export function buildRewritePrompt(action: RewriteAction): string {
  return [
    'Eres un asistente que edita mensajes de WhatsApp que un asesor va a enviar a un cliente.',
    INSTRUCTIONS[action],
    'Conserva datos, precios, fechas, nombres, enlaces y emojis tal cual.',
    'Responde SOLO con el mensaje final, sin comillas, sin explicaciones ni alternativas.',
  ].join('\n')
}

/** Strip wrapping quotes / a leading label the model sometimes adds. */
export function cleanRewrite(text: string): string {
  return text
    .trim()
    .replace(/^(mensaje( final)?|message)\s*:\s*/i, '')
    .replace(/^["“']([\s\S]*)["”']$/, '$1')
    .trim()
}
