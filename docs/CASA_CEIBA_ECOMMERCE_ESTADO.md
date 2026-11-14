# Casa Ceiba — estado del ecommerce autónomo

Actualizado: 14/11/2026 (modo autónomo **activado** a las 06:05 UTC). Primera versión: 13/11/2026 noche (Guatemala). Ejecuta `docs/CASA_CEIBA_PLAN_ECOMMERCE_AUTONOMO_PARA_CLAUDE.md`.
Fuente de la lectura: `outputs/cc-estado-actual-2026-11-13b.json` (script `tmp/cc-state-readonly-20261113b.mts`, solo lectura).

## 0. Estado vigente (14/11/2026, ~06:10 UTC)

**Modo autónomo ACTIVADO** por decisión explícita del propietario («después del merge del PR nuevo», 14/11):

- PRs en producción: #372 (`28f9776f`), #373 (`8a38eff6`) y #374 (`f6424518`, contenedor healthy, `/api/health` 200).
- `orders_live=true` para Casa Ceiba (evidencia: `outputs/activacion-orders-live-2026-11-14.json`).
- Dropify: «Sincronizar órdenes automáticamente» y «Sincronizar órdenes pagadas automáticamente» **marcadas**, guardadas («Configuraciones guardadas con éxito») y verificadas tras recargar. «Crear producto en Dropi» sigue desmarcada y «Limpiar nota» marcada, sin cambios.
- Antes de activar se comprobó: cero pedidos abiertos sin despachar (nada que Dropify importara de golpe), cero avisos pendientes y cero intentos bloqueados. Los borradores #D1–#D4 siguen abiertos y no son pedidos.
- Desde ahora, los pedidos de la web y de WhatsApp van solos a Shopify y de ahí a Dropi. El chat emite enlaces de pago reales de Recurrente. Excepciones → aviso al propietario (§2.1).
- **Sin evidencia real todavía:** ningún pedido ha recorrido el flujo activado. El primer pedido real debe revisarse de punta a punta: WhatsApp, correo, importación a Dropi, guía y entrega.
- **Para PAUSAR:** desmarcar las dos casillas en Dropify y apagar «Crear pedidos reales» (Ajustes → Shopify).

## 1. Estado de partida comprobado (14/11 04:30 UTC)

| Elemento | Lectura actual | Cambio vs. fotografía previa |
| --- | --- | --- |
| Código | main `2dbf4758` (#371), salud HTTP 200 | Igual |
| Tienda | `x0rkkg-b4.myshopify.com` = «Casa Ceiba», primario `casaceibagt.myshopify.com`, GTQ | Alias comprobados: misma tienda |
| Dropify | Ambas sincronizaciones **desmarcadas**, guardado («Configuraciones guardadas con éxito») y verificado tras recargar | Pausa hecha por Claude el 13/11 |
| `orders_live` | `false` en la lectura; **`true` desde el 14/11 06:05 UTC** (ver §0) | Activado por decisión del propietario |
| Recurrente | Clave **live** y secreto de webhook presentes | Nuevo dato: los enlaces cobran dinero real |
| Plantillas | **13/13 APPROVED** en `message_templates` | Antes 3 aprobadas |
| Catálogo | 32 productos, 32 activos y enlazados; última sincronización 12/11 04:24 UTC | Sin sincronizar desde hace ~1 día |
| #1004 | **Cancelado** el 14/11 05:29 UTC a solicitud del propietario (sin reembolso: COD sin pago; reposición de inventario; sin aviso al cliente). El negocio del CRM pasó a «perdido» por el webhook a los 2 s; no se envió ningún mensaje | Evidencia: `outputs/cancelacion-pedido-1004-2026-11-14.json` |
| Borradores | #D1 (Q169, tarjeta), #D2 (Q500), #D3 (Q199, tarjeta), #D4 (Q300, tarjeta), abiertos | Igual. No se tocaron |
| Cola de avisos / intentos | Vacías | Igual |
| Webhooks de app | Ninguno (los de Shopify vienen de Ajustes → Notificaciones) | — |

## 2. Decisión de integración con el proveedor (fase A3)

**Historial:** la decisión inicial y la tabla siguientes corresponden a la fase con sincronización pausada. Fueron sustituidas operativamente por el modo aceptado en §2.1 y activado en §0. No interpretar «bloqueada/manual» de este historial como el estado actual del envío COD. El riesgo que permanece es que web COD importa antes de confirmar. Revisión posterior de ventas y SAC: `docs/CASA_CEIBA_AUDITORIA_VENTAS_SAC_2026-11-14.md`; sus mejoras nuevas todavía están en rama y no se han aplicado al prompt vivo.

**Capacidades confirmadas:**

- Dropify (pantalla Configuración General, 13/11): solo 4 casillas. Son «sincronizar órdenes», «sincronizar órdenes pagadas», «crear producto en Dropi» y «limpiar nota». **No hay filtro por etiqueta ni regla por estado de confirmación.**
- Dropi no publica una API oficial de órdenes. Solo hay documentos de terceros, no oficiales y contradictorios entre sí. Un proyecto público afirma explícitamente que la API no es abierta. No se construye sobre eso.

**Decisión por método de pago:**

| Vía | Decisión | Estado |
| --- | --- | --- |
| Prepago (tarjeta Recurrente) | Regla nativa: dejar activa solo «sincronizar órdenes pagadas». El chat crea **borrador**; solo el webhook firmado, con estado leído de Recurrente e importe y moneda verificados, lo completa como PAGADO → Dropify lo importa | **Implementada, pendiente de prueba externa.** Requiere activar «sincronizar pagadas» y `orders_live`, más un cobro real autorizado |
| Contra entrega (web y chat) | No existe vía automática documentada que respete la confirmación. Marcarlo como «pagado» haría que Dropi no cobre en destino. Un robot que pulse «Enviar a Dropi» está prohibido como solución permanente | **Bloqueada por dependencia:** acceso oficial a la API de órdenes de Dropi Guatemala (documentación, credencial de integración, entorno de pruebas, búsqueda por referencia externa) |

Mientras siga el bloqueo, la liberación de pedidos contra entrega confirmados es un **paso manual del operador**: «Enviar a Dropi» en Dropify para ese pedido. No se presenta como autonomía.

Si se reactiva «Sincronizar órdenes automáticamente», Dropify importará pedidos web contra entrega **sin confirmar**. Eso ya ocurrió con #1004: la importación solo falló por la ciudad inválida. No reactivarla sin una barrera real.

### 2.1 Validación 14/11: ¿pedidos autónomos sin API?

El propietario decidió atender él las excepciones y pidió que la IA le avise. Con esa decisión, **sí es posible operar sin API**, con este diseño («modo autónomo»):

| Canal | Qué pasa | ¿Requiere a alguien? |
| --- | --- | --- |
| Chat, contra entrega | La IA solo crea el pedido después de que el cliente confirma el resumen. Con `orders_live` activo es un pedido real, que Dropify importa solo | No |
| Chat, tarjeta | Borrador → pago verificado en Recurrente (importe y moneda) → pedido PAGADO, que Dropify importa solo | No |
| Web, contra entrega | Dropify lo importa **al crearse**, antes de confirmar. En paralelo se pide la confirmación por WhatsApp | Solo si el cliente cancela o no responde |

**Compromiso aceptado:** en web, la confirmación deja de ser una barrera previa y pasa a ser un control posterior. Un pedido que el cliente rechaza ya está en Dropi y el propietario debe cancelarlo allí antes del despacho.

**Avisos al propietario (excepciones):**

| Excepción | Aviso | Estado |
| --- | --- | --- |
| Cliente cancela por WhatsApp | Notificación + chat asignado: «cancélelo en Dropi y en Shopify antes de que se despache» | Existente (migración 179) |
| 24 h sin confirmar | Notificación: «llame al cliente o cancélelo en Dropi» | Existente |
| Dropi rechaza el pedido («Dropi Sync Error»: ciudad, teléfono, etc.) | Notificación con el motivo de Dropify | **Nuevo (PR 2)** |
| Pago cobrado sin pedido liberado / importe distinto | Alerta crítica | PR #372 (en producción) |
| Sin stock, total distinto, error al crear | El chat pasa a una persona + notificación | Existente / PR #372 |

**Requisitos de activación** (el propietario decidió activarlo el 14/11; estado de cada uno):

1. **Pendiente (propietario):** verificar en su panel de Dropi **qué tan rápido despacha Dropi un pedido importado**. Si sale en minutos, no hay tiempo para cancelar los rechazados y el modo autónomo en web generaría devoluciones.
2. **Resuelto (#373):** la plantilla aprobada `recordatorio_confirmacion` promete «no lo enviaremos hasta que lo confirme», lo cual es falso en este modo. El PR 2 deja de usarla con `orders_live` activo: el recordatorio solo sale como texto dentro de la ventana de 24 h, sin esa promesa. Para recordar fuera de 24 h haría falta una plantilla nueva sin promesa; el propietario pidió dejar la plantilla así por ahora.
3. **No realizada:** prueba con el número de QA del propietario. Se activó sin ella por decisión del propietario.
4. **Hecho (14/11 06:05 UTC):** `orders_live` encendido + las dos casillas de Dropify marcadas, con autorización explícita.

## 3. Cambios de código (PR #372, sin migración)

| Brecha del plan (§3) | Cambio | Prueba que lo protege |
| --- | --- | --- |
| Entorno de pago | Sin enlaces de cobro con `orders_live=false` | `chat-order.test.ts` → «card payment links follow the sales switch» |
| Pago verificado | Se compara la moneda además del importe. Un pago con la venta pausada o que no cuadra se **retiene con alerta crítica** (`shopify_payment_held`) | `api.test.ts` (moneda), `recurrente-webhook/route.test.ts` (4 casos) |
| Total final | El enlace cobra el total del **borrador de Shopify**. Si difiere del total aceptado, no se confirma ni se cobra y pasa a una persona | `chat-order.test.ts` → «the charged total is the one the customer accepted» |
| Clasificación web | Contra entrega solo si la pasarela lo dice (`payment_gateway_names`) | `webhook/route.test.ts` → «payment method of web orders» |
| Cancelación | `orders/cancelled` u `orders/updated` con `cancelled_at` → negocio perdido, sin mensaje ni promesa de reembolso | `webhook/route.test.ts` |
| Entregas parciales | «Entregado» solo con todos los paquetes entregados y estado FULFILLED. En `fulfillments/*` se consulta el pedido real | `webhook/route.test.ts` (2 casos), `api.test.ts` |
| Carritos > 25 | Paginación hasta salir de la ventana de 24 h (tope 300) | `abandoned-carts-sweep.test.ts` (2 casos) |

Consultas GraphQL nuevas comprobadas en solo lectura contra la tienda real: `tmp/cc-verify-cart-query-readonly.mts`.

## 4. Matriz de QA (§6)

Tipos de evidencia: **S** = simulado (prueba automática con mocks: prueba nuestro código, no acredita a Dropi ni a Recurrente). **L** = lectura real. **—** = sin ejecutar.

| Caso | Resultado | Evidencia |
| --- | --- | --- |
| COD web sin confirmar / COD chat incompleto | Cero importaciones mientras la sincronización esté pausada. El chat no crea pedido sin confirmación explícita del resumen | L (Dropify desmarcado y recargado), S (`chat-order`, prompt) |
| COD confirmado válido | Chat: activado con importación automática tras crear el pedido; web: se importa antes de confirmar, según el compromiso de §2.1. La vía con barrera previa para web sigue sin resolverse | S del código; sin prueba externa completa |
| Prepago pendiente / fallido / expirado | Sin liberación: el webhook solo actúa si Recurrente informa `paid` | S |
| Prepago verificado | Borrador → PAGADO con importe y moneda leídos de Recurrente | S. **Pendiente de prueba externa autorizada** |
| Pago duplicado / reintento | Un borrador completado se reutiliza, no se completa dos veces | S (`api.test.ts` «recovers the paid order on a retry») |
| Cambio de moneda / total | Retención + alerta crítica | S |
| Ciudad errónea / municipio incompatible | Chat: la IA pide el municipio y Shopify recibe `city = municipio` (#374). Un municipio de la capital con otro departamento se detiene. Los demás los valida Dropi, y su rechazo avisa al dueño (#373). Web: lo que escribe el cliente; si Dropi lo rechaza, aviso | S (#374, #373). Caso real: #1004 «Guantemala» |
| Sin stock / API caída | Bloquea pedido y enlace | S (`chat-order.test.ts`) |
| Cambio de precio / descuento | El chat no cobra un total distinto del aceptado | S. Envío e impuestos: hoy es envío gratis fijo; falta política |
| Cambio tras confirmar | El prompt exige un nuevo resumen y una nueva confirmación | Solo prompt; sin prueba dedicada |
| Dos pedidos del mismo contacto / tras 30 min | Bloqueo compartido 30 min (migración 179). Una compra nueva después sigue siendo posible | S (`chat-order.test.ts`) |
| Timeout del proveedor | **No aplica todavía:** no hay adaptador de Dropi | — |
| Doble worker / evento duplicado | Reserva persistente de intentos y cola con clave única | S (migración 179, pruebas previas) |
| Cancelación antes / después de importar | Shopify → negocio perdido, sin mensaje. Dropi no se consulta (sin API) | **L**: #1004 cancelado en producción, negocio «perdido» a los 2 s, cero mensajes |
| Dos paquetes, uno entregado | Queda «Enviado» | S |
| Plantilla pendiente / fuera de 24 h / excluido | Cola sin texto libre fuera de ventana; respeta «Sin IA» | S (pruebas previas). Plantillas: L (13 aprobadas) |
| Guía y entrega final | Avisos deduplicados por clave de evento | S. Real: sin envíos todavía |
| Firma inválida / otra cuenta | 401 sin mutar | S (pruebas existentes de HMAC y Svix) |

## 5. Guía breve de operación

- **Pausar ventas nuevas (interruptor):** Ajustes → Shopify → apagar «Crear pedidos reales» (`orders_live=false`). Con esto, el chat crea solo borradores, no emite enlaces de cobro, y los pagos tardíos se retienen con alerta. Lectura, seguimiento, avisos ya válidos y conciliación siguen funcionando.
- **Modo autónomo (vigente):** Dropify importa solo, sin pasos manuales en el camino normal:
  - Pedidos web: al crearse.
  - Pedidos de chat contra entrega: al confirmar el cliente.
  - Prepago: al quedar pagado.
- **Avisos que exigen acción del propietario:**
  - «Cliente cancela» o «24 h sin confirmar» → cancelar en Dropi y en Shopify antes del despacho.
  - «Pedido #X no llegó a Dropi» → corregir los datos (normalmente ciudad o municipio) en Shopify y reenviarlo desde Dropify, o cancelarlo.
- **Alerta `shopify_payment_held`:** hay dinero cobrado sin pedido liberado. Revisar el cobro en Recurrente y el borrador en Shopify. Completar como PAGADO o resolver con el cliente. No reembolsar sin política.
- **Intento «blocked»** (`shopify_order_attempts`): el resultado en Shopify es incierto. Buscar el pedido o borrador del chat en Shopify antes de crear otro.
- **No hacer:** reenviar en lote pedidos o borradores antiguos, ni cancelar o reembolsar en masa como forma de revertir. Pausar con el interruptor de arriba más las dos casillas de Dropify.

## 6. Estado por capacidad

| Capacidad | Estado |
| --- | --- |
| Catálogo, fotos y stock en chat | Operativa y comprobada (auditoría 13/11) |
| Pedido por chat → Shopify → Dropi | **Activada** el 14/11 (`orders_live=true` + Dropify). Sin pedido real todavía |
| Confirmación COD por WhatsApp (plantillas) | Implementada; 13 plantillas aprobadas. En modo autónomo es un control posterior (no retiene el envío) |
| Cobro con tarjeta → pedido pagado → Dropi | **Activada**, sin cobro real todavía |
| Pedido web contra entrega → Dropi | **Activada**: importación automática al crearse; la confirmación va en paralelo |
| Municipio en pedidos de chat | En producción (#374). Validación completa: pendiente del catálogo de Dropi |
| Aviso de rechazo de Dropi | En producción (#373) |
| Correo al cliente | Confirmación de Shopify comprobada (#1004). Correo de envío: depende de Dropify, sin comprobar |
| Enviado / entregado / parcial / cancelado | Implementada (simulada). Pendiente de evidencia real |
| Retención de pagos anómalos | Implementada, en producción (#372, `28f9776f`) |
| Panel de conciliación (§B4) | Pendiente |
| Reconciliación programada | Pendiente |

**Autonomía con supervisión de excepciones:** el camino normal no requiere a nadie; las excepciones avisan al propietario. **No está comprobada de extremo a extremo:** falta el primer pedido real.

## 7. Lo que necesita el propietario

1. **Dropi:** comprobar en su panel cuánto tarda en despacharse un pedido importado. Si es cuestión de minutos, no hay tiempo de cancelar los pedidos web que el cliente rechace.
2. **Políticas** (no se inventan): costo o gratuidad del envío y cobertura, municipios excluidos, plazos, mínimo para contra entrega, devoluciones y reembolsos. FEL: con su responsable fiscal.
3. **Primer pedido real:** avisar a Claude para revisarlo de punta a punta: WhatsApp, correo de envío, importación, guía y entrega.
4. Opcional, a futuro: acceso oficial a la API de órdenes de Dropi y su catálogo de ciudades. Permitiría devolver la confirmación a una barrera previa y validar municipios.
