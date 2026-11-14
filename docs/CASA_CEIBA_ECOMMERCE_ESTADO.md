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
4. **Effi (segundo proveedor):** ver §8.3 — verificación de la empresa en Effi y respuestas de soporte antes de construir.
5. Opcional, a futuro: acceso oficial a la API de órdenes de Dropi y su catálogo de ciudades. Permitiría devolver la confirmación a una barrera previa y validar municipios.

## 8. Segundo proveedor: Effi (diseño, sin implementar)

Investigado el 14/11/2026 en la cuenta de Effi del propietario (empresa «CASA CEIBA», ID Effi 61216), en modo solo lectura. No se creó ni guardó nada en Effi ni en Shopify. Objetivo: tener más productos sin que se mezcle con el canal de Dropi.

### 8.1 Lo comprobado

- **Catálogo:** 9,366 artículos de dropshipping con existencias, en quetzales, con costo, precio sugerido y ganancia. Ejemplo: plancha Sokany, costo Q68 y sugerido Q190.
- **Proveedores en Guatemala:** 44 proveedores con 97 convenios modelo, casi todos con «bodega propia» en Guatemala. Cada proveedor tiene una bodega principal y otra de garantías.
  - Volumen real (contador de ventas de cada proveedor): DistriGuatemala ~253,000, Grupo Luna ~171,000, Sicommer ~174,000, Grupo Blue ~134,000, 60 Segundos ~121,000 (3,544 artículos) y AS Clic ~112,000.
- **Condiciones de los convenios** (iguales en los 5 revisados: Unmerco, Importadora El Mayorista GTM, Grupo Ecodrops, Capeli y Bella Dama):
  - Despacha el **proveedor**.
  - La guía la crea el **distribuidor** (nosotros).
  - Liquida el dinero la **transportadora (Efficommerce)**.
  - Las **entregas fracasadas corren por cuenta del distribuidor**.
  - Las devoluciones las paga quien causó la falla.
  - Garantías por defecto de fábrica: reporte en ~24 h con foto y video.
  - Para vender hay que aprobar un convenio como distribuidor («Aprobar convenio único como distribuidor»).
- **API oficial** (Integraciones → Documentación API):
  - Autenticación con `Bearer <API key del usuario>`. La clave vence a los 360 días y se renueva en Administración → Usuarios.
  - Límite de 600 peticiones por minuto; al pasarlo responde 429 con `Retry-After`.
  - Los `POST` aplican las mismas validaciones que el formulario web.
  - `idempotency_key` es obligatorio: un reintento con el mismo valor responde 409 y no duplica.
- **Endpoints que necesitaría el flujo:**
  - `Consultar artículos`: filtros `dropshipping_distribuidor` (artículos vinculados a un proveedor), `existe_vinculacion` y `articulo_ecommerce`.
  - `Crear remisión de venta`: el campo `convenio_dropshipping` indica el convenio con el que se vende (1 = sin dropshipping). La dirección va como datos: país, provincia, ciudad, dirección y referencia.
  - `Crear orden de venta`: no tiene campo de dropshipping, así que la venta de dropshipping va por remisión.
  - `Crear guía de transporte`:
    - En Guatemala la única transportadora integrada es **Cargo Expreso (CAEX)**, en GTQ, y es la que la cuenta tiene habilitada en el formulario de guías. Gintracom opera en Ecuador y República Dominicana. El número de guía, el flete y el estado los define la transportadora.
    - La tabla de cobertura de Effi no tiene filas para CAEX, así que no publica cobertura ni plazos; el flete se conoce al cotizar o crear la guía.
    - Si se cobra al entregar, hay que enviar `valor_recaudo`.
    - Si falla la API de la transportadora, la guía queda creada y anulada automáticamente.
    - En las guías de dropshipping, el destinatario pertenece al distribuidor (nosotros). Coincide con los convenios: la guía la crea el distribuidor.
  - Consultas de guías, cambios de estado, novedades y soluciones de novedades. Movimientos de EffiWallet: allí entra el dinero cobrado.
- **Ciudades:** Guatemala está desglosada por zona (por ejemplo «Guatemala (Zona 1)»). Sirve para validar el municipio antes de crear el envío.
- **Webhooks** (Integraciones → Webhooks):
  - Eventos útiles: creación de remisión de venta, creación de guía de transporte, cambio de estado de guía de transporte, y creación y solución de novedad de guía.
  - Configuración: URL destino y cabeceras propias opcionales. Al crearlo se genera un secreto para firmar los avisos, y se muestra una sola vez.
  - El formato de la firma (cabecera y algoritmo) no está documentado ni en la API ni en la web.
  - **Solución de diseño:**
    - Autenticar con una cabecera propia que contenga un secreto generado por el CRM; Effi la envía en cada aviso.
    - Tratar el contenido del aviso solo como señal y volver a leer la guía por la API antes de actuar, igual que con Recurrente.
    - Si Effi documenta la firma, se agrega como segunda verificación.
- **Plan de Effi:** precio público en Guatemala desde **Q330/mes** (START: 1 sucursal y 2 usuarios), PRO Q420 y BUSINESS 1 Q590; 20 % menos con pago anual. No se publica si el dropshipping exige plan pagado ni las comisiones por envío.
- **EffiWallet:** la cuenta ya tiene una wallet con «Efficommerce Guatemala» como responsable del saldo, hoy en Q0. Los plazos de liquidación no están publicados.
- **Verificación de la empresa:** pide foto del documento de identidad y video del usuario principal (con cámara web) y documentos adjuntos. Solo la puede hacer el propietario.
- **Dropify con productos que no son de Dropi:**
  - Según los foros de Shopify, Dropify no ignora esas líneas: el pedido falla con una nota de Dropi del tipo «el producto no existe o no se puede crear».
  - En Casa Ceiba «Crear producto en Dropi» está desmarcada, así que Dropify no los creará.
  - Conclusión práctica: un pedido solo de Effi dejará en Shopify un «Dropi Sync Error» esperado, y uno mixto probablemente no entrará a Dropi completo.
- **Conector Shopify de Effi:**
  - Funciona con el Client ID y el secreto de una app de Shopify, la bodega (location) y los días de entrega.
  - Opción «Permitir solo pedidos confirmados».
  - **No filtra por producto:** importaría todos los pedidos de la tienda.

### 8.2 Decisión de diseño: no usar el conector Shopify de Effi

Dropify ya importa todos los pedidos a Dropi. Si además se conecta Effi a Shopify, cada pedido iría a los dos proveedores. Por eso Effi se integra **desde el CRM**, pedido por pedido:

1. **Marcar el proveedor de cada producto en Shopify.** Una etiqueta o el campo «vendor» del producto indica `dropi` o `effi`. Los de Effi además guardan su id de artículo vinculado y el código de convenio.
2. **Al entrar un pedido**, el CRM lo enruta según sus productos. Los momentos son los mismos de hoy: un pedido web al crearse, uno de chat al confirmarlo el cliente y uno con tarjeta al quedar pagado.
   - **Solo productos de Dropi:** sin cambios; Dropify lo importa.
   - **Solo productos de Effi:**
     - El CRM crea la remisión con `convenio_dropshipping` y la guía con `valor_recaudo` si se cobra contra entrega.
     - `idempotency_key` = id del pedido en Shopify.
     - Se registra en `shopify_order_attempts`, igual que hoy, para no duplicar entre webhooks y reintentos.
   - **Carrito mixto:** como Dropify probablemente rechaza el pedido completo, no se puede dejar pasar tal cual.
     - Por chat, la IA lo separa en dos pedidos de Shopify, uno por proveedor.
     - Por la web, el CRM avisa al propietario para dividirlo. Alternativa simple: no publicar el mismo tipo de producto con los dos proveedores y mostrar los de Effi en una colección aparte.
3. **Seguimiento:**
   - El webhook de Effi «Cambio de estado de guía» llega a una ruta nueva del CRM. La ruta comprueba la cabecera secreta propia y luego vuelve a leer la guía por la API.
   - Con el número de guía, el CRM crea el *fulfillment* en Shopify con tracking. Así funcionan sin cambios el correo de envío de Shopify y los avisos de WhatsApp que ya existen (`fulfillments/*` → `trackingSentence`, entregado → `orderFullyDelivered`).
4. **Excepciones con aviso al propietario,** como hoy con Dropi (§2.1):
   - Novedad de guía. Importa más que con Dropi: las entregas fracasadas las paga el distribuidor.
   - Remisión o guía rechazada por Effi: sin existencias, precio mínimo o dirección.
   - Guía anulada por fallo de la transportadora.
5. **Ajuste obligatorio en lo ya desplegado:** la alerta «Dropi rechazó el pedido» (`src/app/api/shopify/webhook/route.ts`, `hasDropiSyncError`) no debe saltar en pedidos que solo traen productos de Effi. Esos pedidos dejarán el «Dropi Sync Error» de forma esperada.

Piezas nuevas estimadas:
- Configuración de Effi por cuenta (API key cifrada, sucursal, bodega, transportadora y tipo de servicio) en Ajustes → Shopify.
- Mapa producto → proveedor.
- Cliente de la API de Effi.
- Ruta del webhook de Effi.
- Pruebas.
- Migración solo si el mapa de productos no cabe en metacampos o etiquetas de Shopify.

### 8.3 Pendiente antes de construir

Segunda investigación (14/11), ya resuelto:
- Quién crea la guía: el distribuidor (convenios y API).
- Transportadora en Guatemala: solo CAEX, y está habilitada en la cuenta.
- Firma de webhooks: se resuelve con cabecera propia más relectura por API.
- Comportamiento de Dropify: según foros, rechaza el pedido; falta confirmarlo en Casa Ceiba.
- Precio del plan: desde Q330/mes.

Sigue pendiente del propietario, porque no se puede resolver sin él:
1. **Verificación de la empresa:** foto del documento, video con cámara web y documentos. Probablemente se exige para la API y los convenios.
2. **Preguntas a soporte Effi Guatemala (+502 3996 2821):**
   - Tarifa de flete de CAEX y quién la paga.
   - Plazo de liquidación del recaudo a EffiWallet y su costo de retiro.
   - Si el dropshipping exige plan pagado y si hay comisión por envío.
3. **Decisión comercial:** aceptar que las entregas fracasadas corren por cuenta del distribuidor y elegir proveedores y productos concretos para la prueba.

Por comprobar en la primera prueba autorizada:
- Que Dropify marque «Dropi Sync Error» en un pedido solo de Effi y no lo importe.
- El flujo completo: remisión, guía CAEX, aviso de Effi, *fulfillment* en Shopify y WhatsApp.
- El manual «Shopify Temporal 2026» de Effi (PDF de más de 10 MB) no se leyó; no hace falta si no se usa el conector.

Reglas: la API key de Effi va solo a Ajustes del CRM, cifrada; nunca al chat ni al repo. La primera remisión o guía real requiere el «sí» explícito del propietario, porque genera un despacho y un cobro reales.
