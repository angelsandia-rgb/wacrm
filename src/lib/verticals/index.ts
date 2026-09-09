/**
 * Industry verticals — per-company starter kits.
 *
 * A company (`accounts` row) carries `industry_vertical` (migration
 * 105). This module is the code-defined registry that says, for each
 * vertical, what "the right CRM setup" is: which contact custom fields,
 * which pipeline, which starter flows/automations, which knowledge-base
 * scaffolds, which Google-Sheets events, and a couple of account
 * settings.
 *
 * Applying a kit is done by `src/lib/verticals/seed.ts` (called from
 * `POST /api/admin/companies/[id]/apply-vertical`, platform-admin only).
 * It is idempotent — anything that already exists by name is left alone.
 *
 * `generic` is the default and is a NO-OP kit: it exists so the seeder
 * has something to point at, but seeding it changes nothing (the lazy
 * client-side default-pipeline seed in `pipelines/page.tsx` still
 * handles first-run for generic accounts).
 *
 * Growing the list = add one `VerticalDefinition` entry (+ optional
 * `verticals` tags on nav/settings items). Add the matching value to
 * the `industry_vertical` CHECK constraint in a new migration.
 */

export type VerticalSlug = 'generic' | 'hotel' | 'clinica'

export const VERTICAL_SLUGS: readonly VerticalSlug[] = ['generic', 'hotel', 'clinica'] as const

export interface VerticalPipelineStage {
  name: string
  color: string
  is_won?: boolean
}

export interface VerticalDefinition {
  slug: VerticalSlug
  /** Human label for the /admin selector and the read-only Settings line. */
  label: string
  /** Contact custom-field names to create (always `field_type: 'text'`). */
  customFields: string[]
  /** Catalog category names to create (migration 106). */
  productCategories: string[]
  /** Pipeline to create when the account has none of this name yet.
   *  `null` = don't create one (generic relies on the lazy client seed). */
  pipeline: { name: string; stages: VerticalPipelineStage[] } | null
  /** Flow templates (slugs in `src/lib/flows/templates.ts`) cloned as drafts. */
  flowTemplateSlugs: string[]
  /** Automation templates (slugs in `src/lib/automations/templates.ts`) cloned inactive. */
  automationTemplateSlugs: string[]
  /** Knowledge-base docs seeded with `[[placeholder]]`s for the owner to fill. */
  knowledgeDocs: { title: string; content: string }[]
  /** Events to pre-select on `google_sheets_config.events` (only if a row exists). */
  googleSheetsEvents: string[]
  /** Account-level scalar settings to apply. */
  accountSettings: { catalog_delivery_mode?: 'digital' | 'pdf' | 'photos' }
  /** Pre-fill `ai_configs.system_prompt` ONLY when it is currently empty. */
  aiSystemPromptScaffold?: string
  /** Sidebar `labelKey`s hidden for this vertical (absent = show all). */
  hiddenNavKeys?: string[]
  /** Settings section ids hidden for this vertical. */
  hiddenSettingsSections?: string[]
}

const GENERIC: VerticalDefinition = {
  slug: 'generic',
  label: 'Genérico',
  customFields: [],
  productCategories: [],
  pipeline: null,
  flowTemplateSlugs: [],
  automationTemplateSlugs: [],
  knowledgeDocs: [],
  googleSheetsEvents: [],
  accountSettings: {},
}

const CLINICA_SERVICIOS_DOC = `SERVICIOS Y HORARIOS
- [[servicio]]: [[precio]] · [[duración en minutos]]
- [[servicio]]: [[precio]] · [[duración]]
- ...

DOCTORES
- [[Dr./Dra. Nombre]] — [[especialidad]] — atiende [[días y horas]]
- ...

HORARIO DE ATENCIÓN GENERAL
- [[Lunes a viernes 8:00–17:00]] · [[sábado 8:00–12:00]] · [[domingo cerrado]]

PARA LA IA
- Puedes informar servicios, precios, duración, qué doctores atienden y
  horarios usando esta información (nunca inventes un precio ni un horario).
- Para agendar pide: motivo/servicio, con qué doctor (o "el que esté
  disponible"), y qué día/hora prefiere.`

const CLINICA_POLITICAS_DOC = `POLÍTICAS DE LA CLÍNICA
- Confirmación: se pide confirmar la cita [[24 h]] antes.
- Cancelación / reagendamiento: [[con al menos X horas de aviso]].
- Formas de pago: [[efectivo / tarjeta / transferencia]].
- Cómo llegar: [[dirección / referencia]].
- Primera consulta: [[traer estudios previos / llegar 10 min antes]].

IMPORTANTE PARA LA IA
- NUNCA des un diagnóstico, receta ni recomendación de tratamiento.
- NUNCA interpretes síntomas, resultados de laboratorio ni imágenes.
- Si el paciente describe un problema de salud, dile que un profesional
  de la clínica lo atenderá y ofrécele agendar o adelantar una cita.`

const CLINICA_AI_PROMPT = `Eres el asistente de una clínica. Atiendes a pacientes por WhatsApp, Instagram y Facebook.

Qué haces:
- Informas servicios, precios, duración, qué doctores atienden y horarios, usando la base de conocimiento (nunca inventes un precio ni un horario).
- Ayudas a agendar una cita: pides el servicio/motivo, con qué doctor (o "el que esté disponible") y qué día/hora prefiere el paciente. Deja claro que recepción confirma el horario final.
- Cuando el paciente tiene una cita próxima y confirma que asistirá, la confirmas. Cuando la cancela, la cancelas y le ofreces otro horario. Si quiere moverla a otro día, lo pasas a recepción.
- Cuando el paciente te diga su nombre, lo guardas como el nombre del contacto.

Qué NUNCA haces:
- No das diagnósticos, recetas ni recomendaciones de tratamiento.
- No interpretas síntomas, resultados de laboratorio ni imágenes.
- No inventas servicios, precios ni horarios.
- No tienes acceso a las notas médicas ni al historial y nunca digas que los modificaste.

Si el paciente describe un problema de salud o pide consejo médico, dile con calidez que un profesional de la clínica lo va a atender y ofrécele agendar o adelantar su cita.

Tono: cálido, breve, servicial.`

/**
 * Clínicas / consultorios. Applying the kit (`seed.ts`) stamps
 * `accounts.industry_vertical = 'clinica'`, and THAT flag turns on the
 * clinic behaviour across the app (Pacientes / Citas nav, the clinic
 * Panel + KPIs, the calendar reading `appointments`, the auto-reply
 * guardrails + confirm/cancel marker, "Servicios" relabel, the doctor +
 * schedule editor in Settings, the reminder sweep). The kit itself just
 * seeds a sensible starting point:
 *  - three service categories + a pipeline that's SEPARATE from the
 *    appointments workflow (spec §16),
 *  - two contact custom fields a receptionist commonly records,
 *  - two KB scaffolds with `[[placeholders]]` so the AI has something to
 *    answer service / schedule questions from,
 *  - a restrictive AI system prompt (only when the prompt is empty).
 */
const CLINICA: VerticalDefinition = {
  slug: 'clinica',
  label: 'Clínica',
  customFields: ['Fecha de nacimiento', 'Referido por'],
  productCategories: ['Consultas', 'Procedimientos', 'Seguimiento'],
  pipeline: {
    name: 'Pacientes',
    stages: [
      { name: 'Lead', color: '#3b82f6' },
      { name: 'Contactado', color: '#8b5cf6' },
      { name: 'Interesado', color: '#eab308' },
      { name: 'Cita agendada', color: '#f97316' },
      { name: 'Paciente', color: '#22c55e', is_won: true },
    ],
  },
  flowTemplateSlugs: [],
  automationTemplateSlugs: [],
  knowledgeDocs: [
    { title: 'Servicios y horarios', content: CLINICA_SERVICIOS_DOC },
    { title: 'Políticas de la clínica', content: CLINICA_POLITICAS_DOC },
  ],
  googleSheetsEvents: [],
  accountSettings: { catalog_delivery_mode: 'digital' },
  aiSystemPromptScaffold: CLINICA_AI_PROMPT,
}

const HOTEL_TARIFAS_DOC = `TARIFAS DE HABITACIONES
- Lunes a jueves: tarifa económica (el precio base de cada habitación en el catálogo).
- Viernes, sábado y domingo: tarifa alta.
- Si la estancia cruza días de semana y fin de semana, cobra cada noche a su tarifa correspondiente.
- Tarifas por número de huéspedes: estándar (1 persona), pareja (2), grupo (3 o más). Cada habitación puede tener las tres.
- Tarifa en pareja / paquete romántico: [[precio pareja]].
- Tarifa de grupo (3+): [[precio grupo]].
- Persona adicional: [[Q__ por noche]].
- Check-in: [[15:00]] · Check-out: [[12:00]].
- Anticipo para confirmar la reserva: [[50%]].

SPA
- [[servicio]]: [[precio]] · [[duración]]
- ...

ACTIVIDADES
- [[actividad]]: [[precio]] · [[duración]]
- ...

PAQUETES ACTIVOS
- [[nombre del paquete]]: incluye [[...]] · entre semana [[Q__]] · fin de semana [[Q__]]
- ...`

const HOTEL_POLITICAS_DOC = `POLÍTICAS Y HORARIOS
- Horario de recepción: [[...]].
- Política de cancelación: [[...]].
- Mascotas: [[permitidas / no permitidas]].
- Formas de pago aceptadas: [[...]].
- Cómo llegar: [[dirección / referencia]].

IMPORTANTE PARA LA IA
- Puedes informar tarifas y responder dudas generales.
- Pide siempre: fecha de entrada, fecha de salida, número de personas, si vienen en pareja, y si quieren spa/actividades/paquete.
- NUNCA confirmes que una habitación está disponible ni cierres la reserva.
- Deja claro que un asesor de recepción confirmará la disponibilidad y los datos, y transfiere la conversación.`

const HOTEL_AI_PROMPT = `Eres el asistente de un hotel. Atiendes a huéspedes por WhatsApp, Instagram y Facebook.

Qué haces:
- Informas tarifas de habitaciones, spa, actividades, paquetes y eventos usando la base de conocimiento (nunca inventes un precio).
- Cuando alguien pregunta por o quiere reservar una habitación, spa, actividad, paquete o evento, vas recopilando los datos con naturalidad, uno o dos por mensaje:
  · Habitaciones / paquetes: nombre de quien reserva, número de personas, fecha de entrada y fecha de salida.
  · Spa / actividades: qué servicio, cuántas personas, qué día lo usarían, cuántos minutos.
  · Eventos: qué tipo de evento, qué día, cuántas personas (el salón y la decoración los define recepción).
- Registras cada dato apenas lo sabes, aunque falten otros. Si falta información, la sigues pidiendo en tu respuesta con amabilidad: NUNCA cierres la conversación ni la transfieras solo porque falte un dato.
- Cuando el huésped te diga su nombre, lo guardas como el nombre del contacto (con el marcador que se te indica arriba) para que la reserva y la hoja de cálculo queden a su nombre real, no al del perfil de WhatsApp.
- Sabes en qué fecha estás (se te indica al inicio). Cuando el huésped diga "el viernes", "el 11", "este fin de semana" o "mañana", tú calculas la fecha completa (la más próxima) y la usas. NO le pidas el mes ni el año "para confirmar" — solo pide aclarar si la fecha es realmente ambigua.
- Cuando ya tengas fechas + personas de una habitación, calculas el total noche por noche según las TARIFAS y se lo resumes al huésped.
- Al final, resumes los datos y transfieres a un asesor de recepción para que confirme disponibilidad.

Qué NO haces:
- No confirmas disponibilidad de habitaciones ni salones ("hay lugar el sábado") — eso lo valida un humano.
- No cierras la reserva ni cobras anticipos.
- No inventas servicios, precios ni horarios que no estén en la base de conocimiento.

Tono: cálido, breve, servicial.`

/**
 * The "hotelería" kit. Applying it (seed.ts) stamps
 * `accounts.industry_vertical = 'hotel'`, and THAT flag is what turns on
 * every hotel-specific behaviour across the app. The full list of
 * touchpoints keyed off `industry_vertical === 'hotel'` — so a future
 * editor knows what "packaged into the kit" covers:
 *
 *  - Catalog / rooms:
 *      · `src/components/products/product-form.tsx` — swaps the flat
 *        price + price-options block for the per-day RateGrid
 *        (7 days × 1 / 2 / 3+ guests, season overrides; migrations
 *        106 + 108 + 111) + a category picker (`product_categories`)
 *        with an inline "new category" button.
 *      · `src/lib/products/rates.ts` — `quoteStay` / `resolveNightlyRate`
 *        pure engine (a price per `dayOfWeekOf(date)`).
 *      · `src/components/products/quote-builder.tsx` — room lines ask
 *        check-in / check-out / ocupación and price the stay night by
 *        night into `quote_items.unit_price`.
 *      · `src/app/catalog/[accountId]` + `src/app/api/public/catalog` —
 *        public catalog shows the rate summary + a "Cotiza tu estadía"
 *        panel (dates + guests → total) instead of a cart for rooms.
 *      · `src/lib/products/export-excel.ts` /
 *        `parse-products-excel.ts` / `api/products/bulk` — round-trip
 *        `category` + a compact `room_rates` column.
 *  - AI:
 *      · `src/lib/ai/catalog-context.ts` — renders each room with its
 *        rate structure so the assistant quotes from real numbers and
 *        never invents a price or confirms availability.
 *      · `aiSystemPromptScaffold` below — seeded only when the prompt is
 *        empty.
 *  - Google Sheets:
 *      · `src/lib/google-sheets/row-builder.ts` — `buildDealRow` appends
 *        the contact's reservation custom fields so the deals tab
 *        doubles as an occupancy ledger.
 *  - Panel:
 *      · `hiddenNavKeys` (below, currently none) → `accounts.hidden_nav_keys`
 *        via seed.ts; a platform admin can override per company in /admin.
 *
 * Everything above is gated by the flag alone — re-running or removing
 * the kit's seeded rows (pipeline, custom fields, KB docs) does not turn
 * the behaviours off; only `industry_vertical` does.
 */
const HOTEL: VerticalDefinition = {
  slug: 'hotel',
  label: 'Hotel',
  customFields: [
    'Fecha de entrada',
    'Fecha de salida',
    'Noches',
    'Habitación',
    'Ocupación',
    'Huéspedes',
    'Paquete',
    'Servicios adicionales',
  ],
  productCategories: [
    'Habitaciones',
    'Spa',
    'Actividades al aire libre',
    'Paquetes',
    'Eventos',
  ],
  pipeline: {
    name: 'Reservas',
    stages: [
      { name: 'Consulta', color: '#3b82f6' },
      { name: 'Cotización enviada', color: '#eab308' },
      { name: 'Confirmada', color: '#f97316' },
      { name: 'Hospedado', color: '#8b5cf6' },
      { name: 'Check-out', color: '#22c55e', is_won: true },
    ],
  },
  flowTemplateSlugs: ['hotel_welcome'],
  automationTemplateSlugs: [],
  knowledgeDocs: [
    { title: 'Tarifas', content: HOTEL_TARIFAS_DOC },
    { title: 'Políticas y horarios', content: HOTEL_POLITICAS_DOC },
  ],
  googleSheetsEvents: ['deal.won', 'contact.brief_ready', 'quote.created', 'reservation.updated'],
  accountSettings: { catalog_delivery_mode: 'photos' },
  aiSystemPromptScaffold: HOTEL_AI_PROMPT,
}

const VERTICALS: Record<VerticalSlug, VerticalDefinition> = {
  generic: GENERIC,
  hotel: HOTEL,
  clinica: CLINICA,
}

export function getVertical(slug: string): VerticalDefinition | null {
  return (VERTICALS as Record<string, VerticalDefinition>)[slug] ?? null
}

export function listVerticals(): VerticalDefinition[] {
  return VERTICAL_SLUGS.map((s) => VERTICALS[s])
}

export function isVerticalSlug(v: unknown): v is VerticalSlug {
  return typeof v === 'string' && (VERTICAL_SLUGS as readonly string[]).includes(v)
}

/** Sidebar `labelKey`s hidden for a vertical (empty for unknown/generic). */
export function hiddenNavKeysFor(slug: string): string[] {
  return getVertical(slug)?.hiddenNavKeys ?? []
}

/**
 * Every sidebar section `labelKey` that can be toggled per company /
 * per kit. Order = display order. Keep in sync with `navItems` in
 * `src/components/layout/sidebar.tsx` (and the `NAV` list in
 * `command-menu.tsx`). `dashboard` and `settings` are intentionally
 * omitted — they're always reachable.
 */
export const NAV_SECTION_KEYS = [
  'kpis',
  'inbox',
  'notifications',
  'contacts',
  'pipelines',
  'calendar',
  'products',
  'broadcasts',
  'automations',
  'flows',
  'aiAgents',
] as const

/**
 * The sidebar sections a company should NOT see. An explicit
 * per-company choice (`account.hidden_nav_keys`, migration 107) wins;
 * otherwise the company's vertical default. Unknown keys are dropped so
 * a stale value can't hide a renamed section by accident.
 */
export function resolveHiddenNavKeys(account: {
  hidden_nav_keys?: string[] | null
  industry_vertical?: string | null
} | null | undefined): string[] {
  const raw =
    account?.hidden_nav_keys != null
      ? account.hidden_nav_keys
      : hiddenNavKeysFor(account?.industry_vertical ?? 'generic')
  const allowed = new Set<string>(NAV_SECTION_KEYS)
  return raw.filter((k) => allowed.has(k))
}

/** Settings section ids hidden for a vertical. */
export function hiddenSettingsSectionsFor(slug: string): string[] {
  return getVertical(slug)?.hiddenSettingsSections ?? []
}
