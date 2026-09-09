# Sandía Clínica — trazabilidad de aceptación (spec §29 / §30)

Dónde queda implementado cada criterio de aceptación. Todo detrás del
vertical `clinica`; cuentas `generic` / `hotel` no cambian.

## §29 — "Debo poder…"

| # | Criterio | Dónde |
|---|---|---|
| 1 | Crear un contacto | Contactos (existente) |
| 2 | Convertirlo en paciente | Contactos → "Convertir en paciente" (`<ConvertToPatientButton>`) → `POST /api/patients` |
| 3 | Abrir su perfil | `/patients/[id]` |
| 4 | Crear un doctor | Configuración → Clínica (`<ClinicSettings>`) → `POST /api/doctors` |
| 5 | Configurar sus horarios | Configuración → Clínica, editor semanal → `PUT /api/doctors/[id]/availability`; ausencias → `POST /api/doctors/[id]/time-off` |
| 6 | Crear un servicio | Productos (relabel "Servicios") → formulario con "Duración (minutos)" |
| 7 | Definir precio y duración | `products.price` + `products.duration_minutes` |
| 8 | Crear una cita | `/appointments` → "Nueva cita" (`<AppointmentDialog>`) → `POST /api/appointments` |
| 9 | Ver únicamente horarios disponibles | El diálogo solo ofrece slots de `GET /api/appointments/slots` (`getFreeSlots` = disponibilidad − ausencias − citas del doctor) |
| 10 | Confirmar la cita | Acción de fila "Confirmada" → `PATCH /api/appointments/[id]` (transición + confirmación) |
| 11 | Reagendarla | Acción "Reagendar" (`<RescheduleDialog>`) → `POST /api/appointments/[id]/reschedule` (guarda fecha anterior en `appointment_history`) |
| 12 | Cancelarla | Acción "Cancelada" → `PATCH` |
| 13 | Marcar No Show | Acción "No Show" → `PATCH` |
| 14 | Marcarla realizada | Acción "Realizada" → `PATCH` (abre el diálogo de visita) |
| 15 | Registrar una visita | `<VisitDialog>` → `POST /api/visits` (cierra la cita ligada si aplica) |
| 16 | Registrar notas | Campos "Notas" / "Observaciones" de la visita; plantillas desde Configuración → Clínica |
| 17 | Adjuntar un archivo | Pestaña "Archivos" del paciente / por visita (`<ClinicFiles>`, bucket privado `clinic-files`) |
| 18 | Ver visitas anteriores | Pestaña "Visitas" del perfil (timeline) |
| 19 | Ver valor generado por paciente | Encabezado del perfil ("Valor histórico") = `SUM(visits.amount)` (`buildPatientAggregates`) |
| 20 | Ver la cita en Calendario | `/calendar` para `clinica` lee `GET /api/appointments/calendar` |
| 21 | Ver próximas citas | Panel de la clínica ("Próximas citas") + lista `/appointments` |
| 22 | Ver ingresos del mes | Panel → KPI "Ingresos" (`computeRevenue`) |
| 23 | Ver pacientes nuevos | Panel → KPI "Pacientes nuevos" (`classifyPatients`) |
| 24 | Ver pacientes frecuentes | Panel → KPI "Pacientes frecuentes" |
| 25 | Ver valor generado por ambos | Los KPI de pacientes muestran "Q… generados" por segmento |
| 26 | Ver tasa de confirmación | Panel → KPI "Tasa de confirmación" (`computeAppointments`) |
| 27 | Ver No Shows | Panel → KPI "No Shows" |
| 28 | Ver tiempo promedio de respuesta humana | Panel → KPI "Respuesta humana prom." (`computeHumanResponse`) |
| 29 | Ver citas sin confirmar | Panel → "Atención requerida" (enlaza a `/appointments?status=SCHEDULED`) |
| 30 | Ver pacientes pendientes de seguimiento | Panel → "Atención requerida" (enlaza a `/patients?filter=follow_up_due`) |
| 31 | Abrir un paciente desde Inbox | `<InboxPatientCard>` en el panel de contacto → "Ver paciente" |
| 32 | Agendar desde una conversación | `<InboxPatientCard>` → "Nueva cita" (`/appointments?patient=`) |
| 33 | Permitir que IA consulte disponibilidad | KB "Servicios y horarios" del kit + prompt del asistente |
| 34 | Permitir que IA confirme/reagende/cancele citas | Auto-respuesta: marcador `[[ACTION:appointment:confirm\|cancel]]`; reagendar lo deriva a recepción |
| 35 | Mantener funcionando los módulos existentes | Todos los hooks revalidan `industry_vertical === 'clinica'`; `generic`/`hotel` sin cambios (tests) |

## §30 — pruebas

| Tema | Test |
|---|---|
| nuevos vs frecuentes | `clinic-metrics/compute.test.ts` › `classifyPatients` |
| ingresos | `compute.test.ts` › `computeRevenue` |
| confirmation rate | `compute.test.ts` › `computeAppointments` |
| No Shows | `compute.test.ts` › `computeAppointments` |
| disponibilidad | `availability.test.ts`, `appointments-slots.test.ts` › `getFreeSlots` |
| conflictos de horarios | `appointments.test.ts` (rechazo por colisión), `appointments-slots.test.ts` (`loadDoctorBusy` filtra estados), `availability.test.ts` › `overlapsBusy` |
| seguimiento | `reminders.test.ts`, `patients.test.ts` (`follow_up_due`), `compute.test.ts` › `computeAttention` |
| respuesta humana | `compute.test.ts` › `computeHumanResponse` |
| conversión conversación → cita | `compute.test.ts` › `computeConversions` |
| permisos / IA no accede a lo que no le toca | `rls.test.ts` (RLS doctor-scope end-to-end como rol `authenticated`) |
| migraciones / triggers tenant-guard | `migration.test.ts` (122+123), `rls.test.ts` (128) |
| auditoría de notas | `visits.test.ts` › `updateVisit` |
| reagendamiento conserva historial | `appointments.test.ts` (a través de `rescheduleAppointment`) |

### Pruebas manuales recomendadas (no automatizables aquí)
- Alta de doctor + horario + servicio + cita real por un usuario admin.
- Un doctor-usuario con `restrict_to_own` entra y confirma que solo ve sus citas.
- Un chat real: el paciente responde "sí" a la confirmación y la cita pasa a Confirmada.
- Registrar el cron (`126_schedule_clinic_reminders_cron.sql` + `CLINIC_REMINDERS_CRON_SECRET`) y verificar que sale el recordatorio 24 h antes.
- Subir y descargar un PDF de paciente (URL firmada).
