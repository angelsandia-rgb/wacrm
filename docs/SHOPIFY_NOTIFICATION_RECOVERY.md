# Recuperación de avisos de pedidos

Antes de desplegar este cambio, aplicar `supabase/migrations/179_shopify_notification_jobs.sql` y verificar que la tabla `shopify_notification_jobs`, la función `claim_shopify_notification_jobs` y la columna `deals.shopify_confirmation_decision` existen. La migración es aditiva: puede aplicarse con la versión anterior aún activa. No aplicar el código antes de la migración.

La cola solamente permite acceso con service role. La clave `(account_id, event_key)` conserva un único trabajo por pedido y tipo de aviso. El cron existente `/api/ai/followups/cron` reclama hasta 25 trabajos vencidos mediante `FOR UPDATE SKIP LOCKED`, con una reserva de diez minutos. Un envío fallido o una plantilla aún sin aprobar se reintenta a los quince minutos. Si un proceso muere, su reserva vence y otro puede continuar.

Los eventos de creación y envío responden 500 cuando no pueden persistir el trabajo. Un fallo de WhatsApp, una vez guardado el trabajo, no obliga a recrear el pedido. Los reintentos de Recurrente recuperan el pedido ya pagado y continúan su registro y aviso.

Los recordatorios y alertas vuelven a consultar la decisión local y el pedido en Shopify: se descartan si se confirmó, solicitó cancelar, canceló o despachó. Un recordatorio también se descarta si el cliente respondió o ya pasaron 24 horas; en ese momento corresponde la alerta al equipo. Las notificaciones internas llevan IDs persistidos para que una repetición de la inserción no las duplique. No se añaden etiquetas de recordatorio antes de enviar.

Supervisión: consultar por cuenta `status`, `attempts`, `next_attempt_at` y `last_error` en `shopify_notification_jobs`. `sent` significa que el proveedor aceptó el envío, no que el cliente lo leyó. Los fallos al reclamar o guardar resultados producen error en el cron y su heartbeat. La cola no repara retrospectivamente avisos perdidos por la versión anterior.

Límite externo: si WhatsApp acepta un mensaje y la conexión o el proceso se interrumpe antes de registrar el resultado, el reintento puede repetir ese aviso. No hay una transacción distribuida con Meta que permita prometer entrega exactamente una vez. Las reservas evitan envíos simultáneos ordinarios y los trabajos enviados no se vuelven a procesar.

Prueba de publicación en una cuenta de pruebas: crear un pedido, verificar su único trabajo; simular indisponibilidad de WhatsApp y luego recuperar; confirmar que un pedido conserva su identidad durante los reintentos; aprobar una plantilla pendiente y comprobar el envío; cancelar mientras un recordatorio está pendiente y comprobar que se descarta. No usar pedidos, cobros ni clientes reales para esta prueba.
