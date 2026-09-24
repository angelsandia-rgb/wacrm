// ============================================================
// Per-account feature flags (accounts.feature_flags, migration 156).
//
// A flag lets a new or risky feature run on one account (the DEMO) and
// be verified with real traffic before every account gets it. The
// platform admin toggles flags per company in /admin. Keys not in this
// registry are ignored everywhere, so removing a flag here retires it.
// ============================================================

export const FEATURE_FLAGS = {
  ai_voice_notes: {
    label: 'Notas de voz para la IA',
    description:
      'La IA transcribe las notas de voz entrantes (OpenAI) y responde a su contenido. Requiere una clave de OpenAI (proveedor o embeddings). Costo aprox. USD 0.003 por minuto.',
  },
} as const satisfies Record<string, { label: string; description: string }>;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlag[];

function isFeatureFlag(key: unknown): key is FeatureFlag {
  return typeof key === 'string' && key in FEATURE_FLAGS;
}

/** Keep only known flags, deduplicated (DB rows may carry retired keys). */
export function normalizeFeatureFlags(raw: unknown): FeatureFlag[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw.filter(isFeatureFlag)));
}

export function hasFeature(flags: unknown, key: FeatureFlag): boolean {
  return normalizeFeatureFlags(flags).includes(key);
}
