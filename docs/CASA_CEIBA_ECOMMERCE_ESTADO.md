# Casa Ceiba — estado del ecommerce autónomo

Actualizado: 13/11/2026 noche (Guatemala). Ejecuta `docs/CASA_CEIBA_PLAN_ECOMMERCE_AUTONOMO_PARA_CLAUDE.md`.
Fuente de la lectura: `outputs/cc-estado-actual-2026-11-13b.json` (script `tmp/cc-state-readonly-20261113b.mts`, solo lectura).

## 1. Estado de partida comprobado (14/11 04:30 UTC)

| Elemento | Lectura actual | Cambio vs. fotografía previa |
| --- | --- | --- |
| Código | main `2dbf4758` (#371), salud HTTP 200 | Igual |
| Tienda | `x0rkkg-b4.myshopify.com` = «Casa Ceiba», primario `casaceibagt.myshopify.com`, GTQ | Alias comprobados: misma tienda |
| Dropify | Ambas sincronizaciones **desmarcadas**, guardado («Configuraciones guardadas con éxito») y verificado tras recargar | Pausa hecha por Claude el 13/11 |
| `orders_live` | `false` | Igual |
| Recurrente | Clave **live** y secreto de webhook presentes | Nuevo dato: los enlaces cobran dinero real |
| Plantillas | **13/13 APPROVED** en `message_templates` | Antes 3 aprobadas |
| Catálogo | 32 productos, 32 activos y enlazados; última sincronización 12/11 04:24 UTC | Sin sincronizar desde hace ~1 día |
| #1004 | PENDING / UNFULFILLED, sin cancelar; etiquetas `por-confirmar` + `Dropi Sync Error`; ciudad «Guantemala» | Igual. No se tocó |
| Borradores | #D1 (Q169, tarjeta), #D2 (Q500), #D3 (Q199, tarjeta), #D4 (Q300, tarjeta), abiertos | Igual. No se tocaron |
| Cola de avisos / intentos | Vacías | Igual |
| Webhooks de app | Ninguno (los de Shopify vienen de Ajustes → Notificaciones) | — |

## 2. Decisión de integración con el proveedor (fase A3)

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
| COD confirmado válido | **Bloqueado** (dependencia Dropi). Hoy el pedido se confirma en CRM y Shopify, y la liberación es manual | — |
| Prepago pendiente / fallido / expirado | Sin liberación: el webhook solo actúa si Recurrente informa `paid` | S |
| Prepago verificado | Borrador → PAGADO con importe y moneda leídos de Recurrente | S. **Pendiente de prueba externa autorizada** |
| Pago duplicado / reintento | Un borrador completado se reutiliza, no se completa dos veces | S (`api.test.ts` «recovers the paid order on a retry») |
| Cambio de moneda / total | Retención + alerta crítica | S |
| Ciudad errónea / municipio incompatible | **Pendiente.** El chat envía el departamento como ciudad. Falta el catálogo de ciudades de Dropi para validar | — (#1004 es el caso real: «Guantemala») |
| Sin stock / API caída | Bloquea pedido y enlace | S (`chat-order.test.ts`) |
| Cambio de precio / descuento | El chat no cobra un total distinto del aceptado | S. Envío e impuestos: hoy es envío gratis fijo; falta política |
| Cambio tras confirmar | El prompt exige un nuevo resumen y una nueva confirmación | Solo prompt; sin prueba dedicada |
| Dos pedidos del mismo contacto / tras 30 min | Bloqueo compartido 30 min (migración 179). Una compra nueva después sigue siendo posible | S (`chat-order.test.ts`) |
| Timeout del proveedor | **No aplica todavía:** no hay adaptador de Dropi | — |
| Doble worker / evento duplicado | Reserva persistente de intentos y cola con clave única | S (migración 179, pruebas previas) |
| Cancelación antes / después de importar | Shopify → negocio perdido. Dropi no se consulta (sin API) | S |
| Dos paquetes, uno entregado | Queda «Enviado» | S |
| Plantilla pendiente / fuera de 24 h / excluido | Cola sin texto libre fuera de ventana; respeta «Sin IA» | S (pruebas previas). Plantillas: L (13 aprobadas) |
| Guía y entrega final | Avisos deduplicados por clave de evento | S. Real: sin envíos todavía |
| Firma inválida / otra cuenta | 401 sin mutar | S (pruebas existentes de HMAC y Svix) |

## 5. Guía breve de operación

- **Pausar ventas nuevas (interruptor):** Ajustes → Shopify → apagar «Crear pedidos reales» (`orders_live=false`). Con esto, el chat crea solo borradores, no emite enlaces de cobro, y los pagos tardíos se retienen con alerta. Lectura, seguimiento, avisos ya válidos y conciliación siguen funcionando.
- **Liberar pedidos a Dropi hoy:**
  - Contra entrega: solo cuando el negocio está en «Pedido creado» con la etiqueta `confirmado-whatsapp`. En Dropify → enviar ese pedido. Revisar antes la ciudad y el municipio.
  - Prepago: se libera solo cuando el pedido está PAGADO en Shopify.
- **Alerta `shopify_payment_held`:** hay dinero cobrado sin pedido liberado. Revisar el cobro en Recurrente y el borrador en Shopify. Completar como PAGADO o resolver con el cliente. No reembolsar sin política.
- **Intento «blocked»** (`shopify_order_attempts`): el resultado en Shopify es incierto. Buscar el pedido o borrador del chat en Shopify antes de crear otro.
- **No hacer:** reactivar «Sincronizar órdenes automáticamente» sin una barrera, reenviar en lote pedidos o borradores antiguos, ni cancelar o reembolsar en masa como forma de revertir.

## 6. Estado por capacidad

| Capacidad | Estado |
| --- | --- |
| Catálogo, fotos y stock en chat | Operativa y comprobada (auditoría 13/11) |
| Pedido por chat → borrador seguro | Operativa (con `orders_live=false`) |
| Confirmación COD por WhatsApp (plantillas) | Implementada. Plantillas aprobadas; pendiente de prueba con el número de QA del propietario |
| Cobro con tarjeta → pedido pagado → Dropi | Implementada, pendiente de prueba externa |
| Liberación de COD confirmado a Dropi | **Bloqueada por dependencia** (API oficial de Dropi) |
| Validación de municipio y departamento | Pendiente (catálogo de ciudades de Dropi) |
| Enviado / entregado / parcial / cancelado | Implementada (simulada). Pendiente de evidencia real |
| Retención de pagos anómalos | Implementada (PR #372, pendiente de merge) |
| Panel de conciliación (§B4) | Pendiente |
| Reconciliación programada | Pendiente |

**No es «100 % autónoma»:** la liberación contra entrega requiere un operador y el cobro con tarjeta no se ha probado de extremo a extremo.

## 7. Lo que necesita el propietario

1. **Dropi Guatemala:** pedir acceso oficial a la API de órdenes. Hace falta documentación, credencial de integración, entorno de pruebas, creación con referencia externa, consulta por referencia y catálogo de ciudades y departamentos. Sin esto, la liberación contra entrega no puede ser automática.
2. **Políticas** (no se inventan): costo o gratuidad del envío y cobertura, municipios excluidos, plazos, mínimo para contra entrega, devoluciones y reembolsos, y responsable de excepciones. FEL: con su responsable fiscal.
3. **Prueba externa controlada de prepago** (requiere autorización específica, ver §2 del plan): con un producto barato y su propio número, cobro real con Recurrente. Antes hay que activar «sincronizar órdenes pagadas» y `orders_live`. Efecto: cargo real y pedido real importado a Dropi.
4. **#1004:** decidir qué hacer con la prueba: cancelarla en Shopify, o corregir la ciudad y confirmar. No se tocó.
5. Número de WhatsApp de QA que el propietario identifique, para probar confirmación y avisos.
