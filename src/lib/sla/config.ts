// Response-time target settings — validation shared by the route and its tests.

export const SLA_DEFAULTS = {
  enabled: false,
  alert_minutes: 10,
  escalate_minutes: 30,
  ai_ack_minutes: 60 as number | null,
  ack_text: 'Recibimos su mensaje. Un asesor le responde en breve.',
  window_start_hour: 8,
  window_end_hour: 20,
}

export type SlaSettings = typeof SLA_DEFAULTS

const int = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

export function normalizeSlaConfig(body: Record<string, unknown>): { ok: true; value: SlaSettings } | { ok: false; error: string } {
  const alert = int(body.alert_minutes, 1, 1440, SLA_DEFAULTS.alert_minutes)
  const escalate = int(body.escalate_minutes, 1, 1440, SLA_DEFAULTS.escalate_minutes)
  const ack = body.ai_ack_minutes === null || body.ai_ack_minutes === '' ? null : int(body.ai_ack_minutes, 1, 1440, 60)
  if (escalate <= alert) return { ok: false, error: 'La escalación debe ser después del primer aviso.' }
  if (ack !== null && ack <= escalate) return { ok: false, error: 'El acuse del bot debe ser después de la escalación.' }
  const text = typeof body.ack_text === 'string' && body.ack_text.trim() ? body.ack_text.trim().slice(0, 500) : SLA_DEFAULTS.ack_text
  return {
    ok: true,
    value: {
      enabled: body.enabled === true,
      alert_minutes: alert,
      escalate_minutes: escalate,
      ai_ack_minutes: ack,
      ack_text: text,
      window_start_hour: int(body.window_start_hour, 0, 24, 8),
      window_end_hour: int(body.window_end_hour, 0, 24, 20),
    },
  }
}
