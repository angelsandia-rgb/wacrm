# Plan de mantenimiento de WACRM

Fecha de revisión: 10 de septiembre de 2026. Este plan cubre la instancia de
WACRM/Chat Sandía desplegada en EasyPanel sobre Contabo, Supabase, WhatsApp,
Zernio, los proveedores de IA, Google y los procesos programados.

## Estado observado

La comprobación pública `GET /api/health?full=1` respondió `status: ok`: la
aplicación, la base, las variables críticas y los ocho heartbeats registrados
estaban sanos. La fotografía agregada de Supabase, sin leer contenido ni datos
personales, mostró:

| Indicador                                  | Estado |
| ------------------------------------------ | -----: |
| Empresas                                   |      3 |
| Contactos                                  |    453 |
| Conversaciones                             |    426 |
| Mensajes                                   |  7,299 |
| Webhooks fallidos o vencidos               |      0 |
| Automatizaciones pendientes/ejecutándose   |      0 |
| Flujos activos                             |      0 |
| Citas / visitas clínicas                   |  0 / 0 |
| Errores pendientes de recordatorio clínico |      0 |
| Handoffs transitorios de IA                |      1 |
| Alertas operativas abiertas                |      5 |
| Tareas vencidas asignadas sin recordatorio |      7 |

Los ocho crons observados habían reportado `ok`. Los de cinco minutos llevaban
entre 5 y 133 segundos desde su última ejecución. Retención y suscripciones
también estaban dentro de su intervalo diario.

Entre el 7 y el 10 de septiembre los mensajes pasaron de 6,844 a 7,299: 455
mensajes adicionales, cerca de 152 diarios. Es un volumen pequeño, pero conviene
medir esta pendiente cada mes porque mensajes y conversaciones no caducan con la
política de retención actual.

## Mantenimiento correctivo inmediato

1. **Recuperar los recordatorios de tareas.** Hay siete tareas asignadas,
   vencidas desde hace hasta 137 horas, sin `reminder_sent_at`; nunca se ha creado
   una notificación `task_due`. El job `task-reminders-sweep` se documentó como
   aplicado, pero su ruta no escribe heartbeat. Hay que revisar `cron.job` y
   `cron.job_run_details`, probar el endpoint con su secreto y añadir
   `tasks_cron` al registro de heartbeats. Umbral futuro: cualquier tarea
   asignada vencida más de 10 minutos sin recordatorio.
2. **Revisar y cerrar cinco alertas abiertas.** Incluyen una alerta crítica de
   liveness de IA del 7 de septiembre, tres avisos de generación/dispatch y una
   desconexión de Google Sheets. La crítica no volvió a actualizarse, por lo que
   la condición parece haberse recuperado, pero `checkAiLiveness` no resuelve la
   alerta al volver a estar sano. Se debe comprobar la empresa afectada, cerrar
   las alertas resueltas y corregir el cierre automático.
3. **Probar la entrega real de alertas.** `notified_at` se escribe antes de
   enviar y `Promise.allSettled` hace que el código considere exitosa la
   notificación aunque Telegram y correo fallen o no estén configurados. Hacer
   una alarma sintética y verificar su recepción; después cambiar el registro
   para marcar éxito solo cuando al menos un canal confirme.
4. **Activar copias recuperables.** La última inspección de Supabase mostró el
   proyecto Free/Nano sin backups programados. Antes de guardar expedientes
   clínicos reales se necesita backup diario de base y Storage, retención
   definida y un ensayo de restauración. Una copia que nunca se restauró no es
   una garantía operativa.
5. **Corregir el healthcheck del contenedor.** Docker consulta `/` y acepta
   cualquier respuesta menor que 500. Debe consultar `/api/health` y exigir un
   `2xx`; así EasyPanel detectará una base inaccesible o variables críticas
   ausentes.
6. **Crear staging para migraciones.** El esquema se mantiene con 129
   migraciones, pero existe historial parcial y varios jobs requieren secretos
   aplicados manualmente. Baselinar una base de staging y probar allí cada nueva
   migración antes de producción.
7. **Implementar la cola persistente de atención.** El fallback de IA reduce las
   conversaciones silenciosas, pero el debounce y parte del envío siguen en
   memoria. Una cola con intentos, `next_attempt_at`, idempotencia, lease y
   dead-letter permite sobrevivir reinicios y caídas de Meta o del proveedor.

## Rutina por frecuencia

### Continua y diaria

- Consultar `/api/health` cada minuto desde un monitor externo y
  `/api/health?full=1` cada cinco minutos. Escalar inmediatamente cualquier
  `down`, cron en `error` o cron de cinco minutos con más de 12.5 minutos.
- Revisar alertas críticas, conversaciones sin respuesta, handoffs sin dueño,
  errores de IA y fallos de WhatsApp al inicio y al cierre del día.
- Confirmar que los crons de automatizaciones, flujos, follow-ups, clínica,
  conversaciones y webhooks avanzan cada cinco minutos. Confirmar diariamente
  retención y suscripciones.
- Revisar `webhook_deliveries`: una entrega vencida durante más de 10 minutos o
  cualquier fila `failed` requiere análisis.
- Confirmar que el backup diario terminó y que el tamaño del archivo coincide
  con su tendencia normal.

### Semanal

- Revisar y combinar los PR de Dependabot después de CI. Dependabot corre los
  lunes, pero ignora Next.js, React, Tailwind y `eslint-config-next`; esas piezas
  necesitan revisión manual mensual.
- Enviar mensajes canario por cada canal activo: WhatsApp directo/Zernio,
  respuesta de IA, plantilla aprobada y, si se usa, Google Calendar/Sheets.
- Revisar calidad y estado del número en Meta, plantillas pausadas/rechazadas,
  validez de tokens y errores 401/429/5xx.
- Revisar consumo de IA por empresa: llamadas, coste, rate limits, respuestas
  vacías, latencia y porcentaje de handoff. Una empresa con tráfico y cero
  respuestas es incidente crítico.
- Revisar tareas vencidas sin recordatorio, follow-ups vencidos, reclamos de
  recordatorio expirados y conversaciones abiertas sin agente.
- Limpiar alertas ya resueltas y documentar causa, corrección y prevención de
  cada alerta crítica.

### Mensual

- Ejecutar `npm audit`, suite completa, lint, TypeScript y build de producción.
  Actualizar Next.js/React/Tailwind de forma manual y conjunta cuando exista una
  versión segura compatible.
- Reconstruir la imagen para incorporar parches de `node:24-alpine`. Conviene
  fijar también el digest de la imagen y actualizarlo de forma controlada para
  que un rebuild sea reproducible.
- Medir VPS: CPU, RAM, disco y reinicios. Alertar con CPU mayor de 70% sostenida,
  RAM mayor de 75% o disco mayor de 70%.
- Medir Supabase: tamaño de BD/Storage, RAM, conexiones, consultas lentas,
  índices sin uso y crecimiento por tabla. Preparar ampliación al llegar a 60%
  de cualquier cuota; actuar antes de 75%.
- Verificar que `run_data_retention()` elimina por lotes y que
  `ai_usage_monthly` conserva los totales antes de borrar el detalle.
- Auditar usuarios inactivos, platform admins, miembros, API keys y webhooks.
  Revocar lo que ya no se use.
- Actualizar la base de conocimiento y prompts de cada empresa; probar respuestas
  sobre precios, políticas, urgencias médicas y escalamiento humano.

### Trimestral

- Restaurar una copia en un entorno aislado y medir RPO/RTO. Verificar tablas,
  Auth y objetos de Storage, no solo que PostgreSQL arranque.
- Ejecutar pruebas de carga en escalones de 10, 25, 50 y 100 empresas, incluyendo
  ráfagas y reinicio del worker. Medir API/webhook p95, cola, duplicados, memoria,
  conexiones y coste de IA.
- Repetir pruebas de aislamiento multiempresa y RLS, especialmente después de
  añadir una vertical, tabla o Storage bucket.
- Revisar política de retención, acceso a notas clínicas, consentimiento y
  exportación/eliminación de datos.
- Rotar secretos de cron, tokens operativos y credenciales revocables en una
  ventana controlada. `ENCRYPTION_KEY` exige re-cifrar todos los secretos antes
  de retirar la clave anterior; no debe cambiarse como una variable normal.
- Ensayar caída de IA, Meta, Supabase y Google. Comprobar fallback, handoff,
  reintento, alertas y recuperación sin duplicar mensajes o citas.

## Checklist de cada despliegue

1. PR obligatorio y CI verde: lint, tipos, pruebas y build.
2. Para migraciones: backup/preflight, prueba en staging, transacción, postflight
   y registro en `schema_migrations`.
3. Comprobar `/api/health?full=1` antes y después.
4. Probar login, recepción de webhook, envío manual y respuesta de IA.
5. Si afecta clínica: comprobar RLS de doctor restringido y una reserva
   concurrente; si afecta hotel: comprobar tarifas/fechas y una reserva real.
6. Vigilar logs, alertas y handoffs al menos 30 minutos. Conservar un rollback
   claro para código y datos.

## Capacidad y criterio para ampliar infraestructura

La última medición del VPS reportó 7.8 GB RAM, 95.8 GB de disco, 2.1 GB de RAM
usada y 12.4 GB de disco. Supabase Free/Nano reportó 46.57 MB de base, 66% de RAM
y 17/60 conexiones. El VPS tiene margen; la primera presión probable está en
Supabase, en los proveedores externos y en los trabajos asíncronos.

No se debe prometer soporte estable para 100 empresas sólo por esos porcentajes.
La ampliación debe ocurrir al cumplir cualquiera de estos criterios:

- Supabase supera 60% de cuota de BD/Storage, 70% de conexiones o 75% de RAM de
  forma sostenida.
- El webhook o API supera 2 segundos p95, aparece una cola mayor de 10 minutos o
  los crons no terminan dentro de su intervalo.
- La tasa de fallos de IA/Meta supera 1% durante 15 minutos.
- Se requiere una segunda réplica; antes hay que sacar debounce, reintentos y
  locks de la memoria del proceso.
- Se empieza a guardar información clínica real; backups probados y plan pagado
  pasan a ser requisito previo, no una optimización futura.

## Responsabilidad

- **Operación de plataforma:** salud, alertas, backups, EasyPanel, Supabase,
  despliegues y respuesta a incidentes.
- **Desarrollo:** dependencias, migraciones, pruebas, colas, rendimiento y
  correcciones de observabilidad.
- **Administrador de cada empresa:** claves de IA, calidad del contenido,
  WhatsApp, plantillas, Google y atención de handoffs.

Cada revisión debe registrar fecha, responsable, resultado, métricas y acción
pendiente. El runbook de recuperación sigue en `docs/RUNBOOK.md`; este documento
define el calendario que evita tener que usarlo.
