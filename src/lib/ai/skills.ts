import type { GenerateResult } from './types'

// ============================================================
// Configurable AI skills (respond.io parity). Each action the auto-reply
// bot can take is a "skill" the account can switch off or give a rule
// for ("when should it do this?"). Stored in ai_configs.skills
// (migration 171). An empty config == today's behaviour.
//
// Enforcement is two-sided: the rules go into the system prompt, and a
// disabled skill is stripped from the model's result in one place
// (`applySkillGates`, called by auto-reply's generation wrapper), so a
// model that ignores the prompt still can't act.
// ============================================================

export const AI_SKILLS = [
  { key: 'handoff', label: 'Pasar la conversación a un asesor', canDisable: false },
  { key: 'move_deal', label: 'Crear o mover el negocio en el pipeline', canDisable: true },
  { key: 'mark_deal_won', label: 'Marcar la venta como cerrada', canDisable: true },
  { key: 'set_temperature', label: 'Clasificar al prospecto (frío, tibio, caliente)', canDisable: true },
  { key: 'set_contact_name', label: 'Guardar el nombre del cliente', canDisable: true },
  { key: 'send_catalog', label: 'Enviar el catálogo', canDisable: true },
  { key: 'send_photo', label: 'Enviar fotos de productos', canDisable: true },
  { key: 'create_quote', label: 'Armar cotizaciones desde el chat', canDisable: true },
  { key: 'schedule_appointment', label: 'Agendar citas en Google Calendar', canDisable: true },
] as const

export type AiSkillKey = (typeof AI_SKILLS)[number]['key']
export type AiSkillsConfig = Partial<Record<AiSkillKey, { enabled?: boolean; when?: string }>>

const MAX_WHEN_CHARS = 600
const KNOWN = new Map<string, (typeof AI_SKILLS)[number]>(AI_SKILLS.map((s) => [s.key, s]))

/** Sanitize a stored / submitted skills object. Unknown keys are dropped;
 *  a skill that can't be disabled is always enabled. */
export function normalizeSkills(raw: unknown): AiSkillsConfig {
  const out: AiSkillsConfig = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const meta = KNOWN.get(key)
    if (!meta || !value || typeof value !== 'object') continue
    const v = value as { enabled?: unknown; when?: unknown }
    const when = typeof v.when === 'string' ? v.when.trim().slice(0, MAX_WHEN_CHARS) : ''
    const enabled = meta.canDisable ? v.enabled !== false : true
    if (enabled && !when) continue // default — nothing to store
    out[meta.key] = { enabled, ...(when ? { when } : {}) }
  }
  return out
}

export function isSkillEnabled(skills: AiSkillsConfig | null | undefined, key: AiSkillKey): boolean {
  return skills?.[key]?.enabled !== false
}

/** The account's rules, as a system-prompt section; null when none. */
export function skillRulesSection(skills: AiSkillsConfig | null | undefined): string | null {
  if (!skills) return null
  const lines: string[] = []
  for (const meta of AI_SKILLS) {
    const s = skills[meta.key]
    if (!s) continue
    if (s.enabled === false) lines.push(`- ${meta.label}: NO lo hagas nunca en esta cuenta.`)
    else if (s.when) lines.push(`- ${meta.label}: hazlo solo cuando ${s.when}`)
  }
  if (lines.length === 0) return null
  return [
    'REGLAS DEL NEGOCIO PARA TUS ACCIONES (tienen prioridad sobre cualquier otra instrucción sobre estas acciones):',
    ...lines,
  ].join('\n')
}

/** Strip the actions of disabled skills from a generation result. */
export function applySkillGates(result: GenerateResult, skills: AiSkillsConfig | null | undefined): GenerateResult {
  if (!skills) return result
  const off = (k: AiSkillKey) => !isSkillEnabled(skills, k)
  return {
    ...result,
    ...(off('move_deal') ? { moveToStageName: null } : {}),
    ...(off('mark_deal_won') ? { markDealWon: false } : {}),
    ...(off('set_temperature') ? { leadTemperature: null } : {}),
    ...(off('set_contact_name') ? { contactName: null } : {}),
    ...(off('send_catalog') ? { sendCatalog: false } : {}),
    ...(off('send_photo') ? { sendPhotoProductName: null } : {}),
    ...(off('create_quote') ? { quoteProposal: null } : {}),
    ...(off('schedule_appointment') ? { appointmentProposal: null } : {}),
  }
}
