# Recuperación de avisos de pedidos

Antes de desplegar este cambio, aplicar `supabase/migrations/179_shopify_notification_jobs.sql` y verificar que la tabla `shopify_notification_jobs`, la función `claim_shopify_notification_jobs` y la columna `deals.shopify_confirmation_decision` existen. La migración es aditiva: puede aplicarse con la versión anterior aún activa. No aplicar el código antes de la migración.

La cola solamente permite acceso con service role. La clave `(account_id, event_key)` conserva un único trabajo por pedido y tipo de aviso. El cron existente `/api/ai/followups/cron` reclama hasta 25 trabajos vencidos mediante `FOR UPDATE SKIP LOCKED`, con una reserva de diez minutos. Un envío fallido o una plantilla aún sin aprobar se reintenta a los quince minutos. Si un proceso muere, su reserva vence y otro puede continuar.

Validación previa: la migración se ejecutó en PostgreSQL embebido (PGlite), incluida su segunda aplicación. Se verificaron las claves por cuenta, el vencimiento y recuperación de reservas, el rechazo de resultados de workers anteriores, la exclusión de trabajos enviados y los permisos de los roles anon/service_role. Esta prueba no sustituye la comprobación con Shopify y WhatsApp en una cuenta de pruebas.

Los eventos de creación y envío responden 500 cuando no pueden persistir el trabajo. Un fallo de WhatsApp, una vez guardado el trabajo, no obliga a recrear el pedido. Los reintentos de Recurrente recuperan el pedido ya pagado y continúan su registro y aviso.

Cada pedido conserva su propio trato y decisión: un pedido nuevo utiliza un trato sin pedido o crea otro, y una repetición del mismo ID recupera su trato existente. No se sobrescribe el pedido anterior del cliente ni se hereda su confirmación o cancelación.

Los carritos también usan esta cola. Se conservan los éxitos de la tabla anterior `shopify_cart_reminders`; sus intentos fallidos pueden recuperarse mientras el carrito siga vigente. Antes de cada envío se consulta el checkout en Shopify: se omiten los completados, vencidos o con otro teléfono y se respetan los contactos excluidos y el horario. Un carrito modificado recientemente espera de nuevo una hora de inactividad. La plantilla debe estar aprobada; si sigue pendiente, el trabajo espera y se reintenta dentro de la vigencia máxima de 24 horas.

Los recordatorios y alertas vuelven a consultar la decisión local y el pedido en Shopify: se descartan si se confirmó, solicitó cancelar, canceló o despachó. Un recordatorio también se descarta si el cliente respondió o ya pasaron 24 horas; en ese momento corresponde la alerta al equipo. Las notificaciones internas llevan IDs persistidos para que una repetición de la inserción no las duplique. No se añaden etiquetas de recordatorio antes de enviar.

Supervisión: consultar por cuenta `status`, `attempts`, `next_attempt_at` y `last_error` en `shopify_notification_jobs`. `sent` significa que el proveedor aceptó el envío, no que el cliente lo leyó. Los fallos al reclamar o guardar resultados producen error en el cron y su heartbeat. La cola no repara retrospectivamente avisos perdidos por la versión anterior.

Límite externo: si WhatsApp acepta un mensaje y la conexión o el proceso se interrumpe antes de registrar el resultado, el reintento puede repetir ese aviso. No hay una transacción distribuida con Meta que permita prometer entrega exactamente una vez. Las reservas evitan envíos simultáneos ordinarios y los trabajos enviados no se vuelven a procesar.

Prueba de publicación en una cuenta de pruebas: crear dos pedidos del mismo contacto y verificar que no comparten respuesta; simular indisponibilidad de WhatsApp y luego recuperar; confirmar que un pedido conserva su identidad durante los reintentos; aprobar una plantilla pendiente y comprobar el envío; completar un carrito mientras su aviso está pendiente y comprobar que se descarta. No usar pedidos, cobros ni clientes reales para esta prueba.
