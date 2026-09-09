# Sandía Clínica — modelo de seguridad

Resumen de cómo el vertical `clinica` protege la información médica
(spec §22). Nada de esto aplica a cuentas `generic` / `hotel`.

## Roles

| Concepto (spec §21) | Implementación |
|---|---|
| **ADMIN** | `profiles.account_role` `owner` / `admin`. Acceso completo. Gestiona doctores, horarios y servicios. |
| **RECEPCIÓN** | `profiles.account_role` `agent`. Crea pacientes / citas, confirma / reagenda / cancela, administra la agenda. Puede ver notas (decisión: "no *necesariamente*" restringido — spec §21). |
| **DOCTOR** | Fila en `doctor_profiles` con `user_id` = el usuario y `restrict_to_own = true`, y `account_role` `agent`/`viewer`. **Solo ve y edita sus propias citas y visitas.** |
| **AGENTE** | `agent` sin `doctor_profiles` → ve todo (como recepción). |

Un doctor con `account_role` `admin`/`owner`, o con `restrict_to_own = false`,
ve todo (no está limitado).

## Aislamiento por doctor — `clinic_doctor_scope(account)`

Función `SECURITY DEFINER` (migración 122). Devuelve el `doctor_profiles.id`
al que el usuario actual está limitado, o `NULL` si ve todo. La usan las
policies RLS de `appointments`, `appointment_history`, `visits` y
`visit_note_revisions`:

```
is_account_member(account_id) AND
(clinic_doctor_scope(account_id) IS NULL OR doctor_id = clinic_doctor_scope(account_id))
```

Verificado end-to-end en `src/lib/clinic/rls.test.ts` (corre las
migraciones reales en PGlite y consulta como el rol `authenticated`, no
como superusuario, para que las policies apliquen de verdad).

## Capas de autorización

1. **RLS (Postgres)** — toda tabla clínica tiene `account_id` + policies
   `is_account_member(...)`; las de citas/visitas suman el scope de doctor.
2. **Guardas de endpoint** — cada ruta de `/api/{patients,doctors,appointments,visits,note-templates,clinic-files,clinic-dashboard}`
   llama `requireRole('viewer'|'agent'|'admin')` **antes** de cualquier
   mutación. Lecturas = `viewer`; escrituras = `agent`; configuración de
   doctores/horarios y borrados = `admin`.
3. **Triggers tenant-guard** (`SECURITY DEFINER`, `REVOKE` de `PUBLIC`/
   `authenticated`) — `guard_clinic_*` rechazan (`23514`) cualquier FK
   (`patient_id` / `doctor_id` / `service_id` / `conversation_id` /
   `visit_id`) que apunte a otra cuenta. RLS no acota FKs.

## Auditoría

- **Notas médicas**: editar `visits.notes` / `visits.observations`
  guarda el texto **anterior** en `visit_note_revisions` (append-only,
  sin `UPDATE`/`DELETE` concedidos) *antes* de escribir el cambio
  (`src/lib/clinic/visits.ts` → `updateVisit`). Visible en el diálogo de
  visita ("Historial de ediciones").
- **Citas**: cada cambio de estado o reagendamiento inserta una fila en
  `appointment_history` (append-only) con `previous_status`,
  `new_status`, fechas anterior/nueva, motivo y `changed_by`.
- **Acciones de IA**: confirmaciones/cancelaciones del bot se registran
  en `ai_action_log` como `appointment_action`.
- `created_by` / `updated_by` en `appointments` y `visits`.

## IA — límites duros

El prompt de auto-respuesta de una cuenta `clinica`
(`buildSystemPrompt` con `clinicGuardrails`) prohíbe: diagnosticar,
recetar o recomendar tratamiento, interpretar síntomas / resultados /
imágenes, e inventar información clínica. El bot **no puede** modificar
notas ni historial (no hay marcador ni herramienta para ello). Solo
puede: informar servicios / precios / horarios / doctores y
confirmar / cancelar la cita del paciente (reagendar lo deriva a
recepción).

## Datos sensibles

- Bucket `clinic-files` es **privado**; las descargas pasan por
  `/api/clinic-files/[id]/download` que genera una URL firmada de 120 s
  tras verificar la cuenta. No hay lectura pública.
- El código clínico registra en logs mensajes de error, nunca contenido
  de notas ni nombres de pacientes.
- Nada de información clínica en `localStorage` (el perfil del paciente y
  el diálogo de visita solo mantienen estado en memoria de React).
