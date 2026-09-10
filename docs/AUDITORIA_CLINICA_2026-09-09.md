# Auditoría de la vertical Clínica - 9 de septiembre de 2026

## Alcance y conclusión

Se revisaron los cambios de la vertical `clinica` desde las migraciones 121 a 128, sus rutas API, agenda, pacientes, visitas, archivos, panel, recordatorios, integración con Google Calendar y acciones autónomas de IA. La revisión incluyó lectura de código, análisis de fallos, pruebas de aislamiento con PostgreSQL embebido, pruebas unitarias, TypeScript, ESLint y compilación de producción.

La implementación original tenía riesgos críticos que impedían considerarla segura para datos clínicos o confiable para atención automática. Los más graves eran: anunciar una confirmación antes de guardarla, permitir a un doctor restringido ver pacientes o archivos ajenos, aceptar dos citas simultáneas para el mismo doctor y marcar recordatorios como enviados antes de que el canal los aceptara. Las correcciones descritas abajo cierran esos casos en código y base de datos.

Esta auditoría reduce fallos reproducibles; no certifica cumplimiento sanitario ni garantiza disponibilidad absoluta. WhatsApp, Supabase y el proveedor de IA siguen siendo dependencias externas.

## Hallazgos corregidos

| ID | Prioridad | Hallazgo | Corrección aplicada |
|---|---|---|---|
| C01 | Crítica | La IA enviaba “cita confirmada/cancelada” antes de persistir el cambio. Si Supabase fallaba, el paciente recibía información falsa. | La mutación se ejecuta antes del mensaje. Si falla, se sustituye el texto por una respuesta segura y se entrega la conversación a recepción. |
| C02 | Crítica | El RLS de pacientes y archivos no respetaba `restrict_to_own`; un doctor restringido podía ver expedientes de otros doctores. | `clinic_can_access_patient`, nuevas políticas para pacientes, visitas, archivos y revisiones, más pruebas como rol `authenticated`. |
| C03 | Crítica | Las políticas de Storage permitían lectura por ruta de empresa y a `viewer` subir archivos. Una ruta adivinada podía saltarse el alcance clínico. | Storage consulta la fila clínica autorizada; solo `owner/admin/agent` suben o eliminan; el doctor restringido solo accede a pacientes propios. |
| C04 | Alta | Dos solicitudes concurrentes podían reservar el mismo doctor y horario después de superar ambas la comprobación previa. | Restricción GiST `appointments_no_doctor_overlap`; el conflicto PostgreSQL `23P01` se presenta como HTTP 409. |
| C05 | Alta | El cron estampaba el recordatorio antes de enviarlo. Un timeout lo perdía para siempre; dos workers podían duplicarlo. | Reclamos atómicos con arrendamiento renovable de 15 minutos. Se estampa como enviado únicamente después del envío; los fallos previos liberan el reclamo para reintento. |
| C06 | Alta | Varias caídas del modelo, límite de cuenta, límite de conversación, contexto ilegible o respuesta vacía dejaban al cliente sin respuesta. | Respuesta determinista sin llamar al modelo, handoff transitorio, alerta y recuperación automática. La recuperación reinicia el contador para evitar una pausa inmediata repetida. |
| C07 | Alta | Una clínica podía usar el agendamiento genérico de Google Calendar y crear un evento sin crear la cita clínica. | Esa herramienta queda deshabilitada para `clinica`; el prompt no afirma una reserva nueva. Nuevas citas y reagendamientos pasan a recepción hasta disponer de herramienta clínica nativa. |
| C08 | Alta | Si fallaba la lectura del calendario ocupado, se interpretaba como “doctor libre”. | Las lecturas fallan cerradas con 503; nunca se ofrecen horarios al no poder validar disponibilidad. |
| C09 | Alta | Cuentas `generic` o `hotel` podían invocar directamente rutas clínicas aunque la interfaz no las mostrara. | Todas las rutas clínicas usan `requireClinicRole`, que valida rol e `industry_vertical` antes de consultar o mutar. |
| C10 | Alta | FKs de historial, revisiones, visitas y archivos podían mezclar empresas en caminos con service role o futuros cambios de RLS. | Triggers tenant-guard verifican empresa, paciente y relaciones; también se endurecieron las políticas de inserción. |
| C11 | Media | Reemplazar disponibilidad hacía `DELETE` seguido de `INSERT`; un bloque inválido dejaba al doctor sin horario. | RPC transaccional `replace_doctor_availability`, probado con rollback ante un bloque inválido. |
| C12 | Media | Ediciones concurrentes de citas, reagendamientos y visitas podían sobrescribirse. | Comparación optimista por `updated_at`; una edición obsoleta recibe 409. |
| C13 | Media | Fechas inexistentes, duraciones extremas, importes no finitos, UUID inválidos y metadatos de archivo sin límites podían causar errores o trabajo excesivo. | Validación de calendario, UUID, duración de 5 a 1,440 minutos, rango monetario, MIME permitido, 15 MB y rango máximo de slots de 62 días. |
| C14 | Media | Errores de Supabase se convertían en listas vacías, métricas cero o disponibilidad aparente. | Las consultas críticas ahora propagan error; las API devuelven fallo recuperable en vez de datos falsos. |
| C15 | Rendimiento | La generación de slots podía producir arreglos muy grandes y los agregados de pacientes consultaban más filas de las necesarias. | Máximo de 2,000 slots y filtros por los pacientes candidatos cuando el conjunto permite una URL segura. |
| C16 | Media | Dos reintentos podían crear dos visitas para una misma cita. | Índice único parcial `uq_visits_appointment` y respuesta 409 legible. |
| C17 | Crítica | `npm audit` detectó una vulnerabilidad crítica de ejecución remota en Next.js, tres altas y avisos moderados en dependencias. | Next.js 16.3.4, Sharp 0.35.4, Nodemailer 9.1.1, js-yaml 4.3.2, Hono 4.13.7 y Vitest 4.1.11. Auditoría final: 0 vulnerabilidades. |

## Garantías actuales de IA clínica

- Nunca anuncia que una confirmación o cancelación tuvo éxito antes de recibir confirmación de la base de datos.
- Ante error del proveedor, clave inválida, límite, respuesta vacía o contexto indisponible, intenta enviar un mensaje fijo de continuidad y deja el caso visible para una persona.
- Los handoffs causados por fallos técnicos son transitorios. Si nadie atendió y pasó el período de recuperación, el bot se reactiva una vez con su contador reiniciado.
- Si la empresa no puede leerse temporalmente, se conserva el prompt médico más estricto: no diagnosticar, recetar, interpretar resultados ni recomendar tratamiento.
- Una clínica solo puede confirmar o cancelar la cita existente que el servidor incluyó en contexto. La IA no puede escribir notas, expedientes ni historial médico.
- La IA todavía no consulta slots vivos ni crea o reagenda citas clínicas. Recoge la solicitud y deriva a recepción. Esta limitación evita reservas ficticias.

La respuesta de contingencia también depende del canal de mensajería. Si WhatsApp/Meta falla después de recibir el mensaje entrante, se registra el handoff, pero el texto fijo podría no salir. La solución estructural es una cola de salida persistente con reintentos e idempotencia.

## Seguridad y privacidad

La base aplica dos límites acumulativos: `account_id` separa empresas y `clinic_doctor_scope(account_id)` limita a un doctor con `restrict_to_own`. Los triggers vuelven a validar las relaciones incluso cuando un proceso usa service role. Las URLs de documentos son firmadas por 120 segundos y el bucket es privado.

Los roles actuales permiten a recepción (`agent` sin perfil de doctor restringido) leer notas médicas. Esto coincide con el diseño implementado, pero debe validarse contra la política real de la clínica y la legislación aplicable. WACRM no queda certificado por esta auditoría para HIPAA, datos sanitarios guatemaltecos u otro marco regulatorio.

## Rendimiento y capacidad para crecer

La última medición documentada del 7 de septiembre mostró 3 empresas, 6,844 mensajes y 46.57 MB de base de datos, con Supabase Free/Nano. Esa fotografía no es una prueba de capacidad para 100 empresas. La RAM del VPS y la RAM de Supabase son recursos separados.

Para 100 empresas, el código clínico queda mejor protegido contra ráfagas y concurrencia, pero todavía hay límites operativos:

1. El cron examina hasta 200 cuentas y envía hasta 150 recordatorios por ejecución de 5 minutos. Soporta 100 cuentas con tráfico moderado; una ráfaga mayor necesita cola justa por empresa para que una clínica grande no retrase a las demás.
2. El panel clínico carga visitas y citas en memoria y limita mensajes a 5,000 por período. Supabase también puede truncar consultas grandes. Antes de operar 100 clínicas con volumen real, los KPI deben moverse a agregados SQL y declarar cualquier resultado parcial.
3. La lista de citas limita a 1,000 filas y filtra búsquedas de paciente en memoria. Debe tener paginación de servidor y búsqueda indexada antes de historiales grandes.
4. El debounce de conversación vive en memoria del proceso. Una segunda réplica puede duplicar trabajo; para escalar horizontalmente se necesita cola persistente y bloqueo por conversación.
5. Un proceso web sigue atendiendo API, webhooks, IA, archivos y cron. Separar workers de IA/recordatorios evita que una ráfaga lenta del modelo consuma la atención HTTP.

El objetivo de 100 empresas requiere una prueba de carga con datos sintéticos y proveedores simulados. Escalones recomendados: 10, 25, 50 y 100 empresas; 30 a 60 minutos por escalón; ráfagas de 5 a 10 veces el promedio; reinicio de worker durante carga. Medir webhook p95, API p95, antigüedad de cola, errores del modelo/canal, duplicados, CPU, RAM, conexiones y crecimiento de BD. No afirmar capacidad comercial de 100 empresas hasta pasar ese ensayo.

## Riesgos pendientes priorizados

1. **P0 - cola persistente de atención.** Guardar cada trabajo de IA/salida con estado, intentos, `next_attempt_at`, clave idempotente y dead-letter. Permite reanudar tras reinicio o caída de proveedor.
2. **P0 - backups y restauración.** La última revisión de infraestructura encontró Supabase Free sin copias programadas. Activar backups y ejecutar un ensayo de restauración antes de almacenar expedientes reales.
3. **P1 - herramienta clínica nativa para IA.** Exponer consultar slots, reservar y reagendar mediante funciones deterministas con autorización, idempotencia y la restricción de solapamiento. Hasta entonces mantener handoff.
4. **P1 - transacciones clínicas completas.** La fila principal se protege, pero algunos historiales auxiliares y el cierre cita-visita siguen siendo operaciones separadas. Moverlos a RPC transaccionales para que no queden auditorías incompletas durante una caída intermedia.
5. **P1 - métricas SQL y paginación.** Eliminar los techos silenciosos de filas y el filtrado en memoria.
6. **P1 - observabilidad por empresa.** Alertas sobre conversación sin respuesta, handoff sin dueño, fallos del cron, reclamos vencidos, latencia p95/p99 y error de cada proveedor.
7. **P2 - retención y mínimo privilegio.** Definir plazos para notas, adjuntos y logs; confirmar si recepción debe ver notas clínicas; registrar acceso a expedientes sensibles.

## Despliegue de base de datos

La aplicación corregida depende de `supabase/migrations/129_clinic_reliability_and_security.sql`. El 9 de septiembre se ejecutó un preflight en Supabase producción: 1 cuenta clínica, 0 citas, 0 visitas, 0 horarios activos superpuestos y 0 citas con visitas duplicadas. La migración se aplicó después dentro de una sola transacción y quedó registrada como `20260909193000 / clinic_reliability_and_security`. No se eliminó ninguna fila clínica.

Comprobaciones posteriores al despliegue:

1. Confirmar que la migración 129 figure en el historial. Completado en esta entrega.
2. Confirmar que el cron `clinic-reminders-sweep` esté registrado cada 5 minutos y que exista `CLINIC_REMINDERS_CRON_SECRET` o `AUTOMATION_CRON_SECRET` en la aplicación.
3. Ejecutar una cita de prueba: confirmar por chat, forzar un fallo de persistencia en staging y verificar que nunca salga el texto de éxito.
4. Ejecutar dos reservas concurrentes del mismo doctor/hora y comprobar un solo éxito y un 409.
5. Probar un doctor restringido contra paciente, visita, revisión y archivo de otro doctor.
6. Vigilar errores `clinic reminders`, `ai auto-reply`, handoffs transitorios y reclamos con `last_error` durante las primeras 24 horas.

## Evidencia de validación

- Suite completa: 179 archivos y 1,813 pruebas, todas aprobadas con Vitest 4.1.11.
- Pruebas PostgreSQL reales para RLS, triggers, arrendamientos y agenda atómica.
- `npm run typecheck`: sin errores.
- `npm run lint`: sin errores.
- `npm audit`: 0 vulnerabilidades en 871 paquetes.
- `npm run build`: compilación de producción correcta con Next.js 16.3.4 y 121 páginas generadas.
- `git diff --check`: sin errores.
- Supabase producción: preflight sin conflictos, migración 129 ejecutada transaccionalmente y postflight por API correcto para columnas de lease y RPC de reclamo.

Los mensajes en `stderr` durante Vitest corresponden a escenarios deliberados de timeout, concurrencia, provider inválido y recuperación.
