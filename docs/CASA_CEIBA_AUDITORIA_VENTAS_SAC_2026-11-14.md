# Casa Ceiba: revisión de #372–375, ventas y servicio al cliente

14 de noviembre de 2026, horario de Guatemala. Auditoría técnica y de instrucciones. No se enviaron mensajes a clientes, no se generaron cobros ni se crearon pedidos de prueba en producción.

## Resultado de la revisión de Claude

Se confirmó en GitHub que #375 está fusionado: commit `213edcfde34015e940f93764d31f13ed9c64a15e`, merge a las 00:17 Guatemala, comprobación de CI aprobada. El repositorio local partía de ese commit. #375 documenta la activación; las modificaciones funcionales están en #372–374.

La lectura de configuración de las 00:29 confirmó `orders_live=true`, IA/autorespuesta activas y modelo gpt-5.4. El CRM registra las trece plantillas como APPROVED. A las 01:04, `/api/health?full=1` respondió 200 con database/env/crons correctos. Esto acredita disponibilidad y configuración, no un pedido entregado ni, por sí solo, la versión exacta del contenedor.

El documento de Claude reporta sincronización automática de Dropify reactivada y guardada. Esta auditoría no volvió a verificar su interfaz por el fallo de conexión con Chrome. Tampoco hizo un cobro o despacho para demostrar la cadena externa.

### Correcciones reales que ya llegaron a main

- #372: comprobar moneda e importe de pago, usar total real del borrador, impedir nuevos enlaces de pago con ventas pausadas, clasificar COD por pasarela y manejar cancelación/entregas parciales.
- #373: aviso por rechazo de Dropify y recordatorio sin la promesa de retención cuando el modo autónomo está activo.
- #374: municipio separado para las nuevas propuestas de compra por WhatsApp y validación geográfica parcial.
- #375: estado operativo y documentación de activación.

La decisión vigente acepta que **web COD se importa al crearse** y su confirmación de WhatsApp ocurre después. Chat COD se crea tras el resumen confirmado; tarjeta sigue borrador hasta pago verificado. Es automatización activada con supervisión de excepciones. Falta evidencia de un recorrido completo real hasta la entrega. Conocer el tiempo de despacho de Dropi sigue siendo importante porque una cancelación puede llegar después de importarlo.

## Problemas encontrados en conversación

El prompt vivo tenía 4,313 caracteres y su última modificación era anterior a los PR recientes. Indicaba terminar cada mensaje con una pregunta que acercara la compra, repetía argumentos de envío gratis/contra entrega y describía la compra como «sin riesgo». Eso podía convertir respuestas útiles, negativas y quejas en nuevos intentos de venta.

En el código seguía una contradicción: el contexto de pedido web pendiente decía que no se enviaba hasta confirmar. La regla global también dificultaba el traspaso de un reclamo porque pedía mantener la conversación y, normalmente, pedir permiso dos veces para una persona.

La base de conocimiento sí contiene una política concreta de cambios y garantía: siete días, daño/defecto de fábrica/producto equivocado, evidencia y revisión del asesor, con accesorios y empaque. Se conservó; no se inventó una política nueva. Se eliminan promesas de reembolso inmediato o de cancelación remota que la IA no puede ejecutar.

## Mejora preparada: venta consultiva y SAC prioritario

Archivo exacto del prompt propuesto: `docs/prompts/casa-ceiba-system-prompt-2026-11-14.md`.

| Dimensión de un ecommerce de calidad | Comportamiento preparado |
| --- | --- |
| Descubrir necesidad | Preguntar solo lo que falta sobre uso/presupuesto; atender directamente al producto del anuncio |
| Recomendar y persuadir | Una opción con razón y beneficio sustentado; comparar una segunda solo si ayuda |
| Resolver objeciones | Reconocer la preocupación y responder a precio, confianza o plazo con el dato pertinente, sin repetir el mismo guion |
| Dar confianza | Total y condiciones claras, pago y garantía con sus límites; sin inventar popularidad, urgencia, reseñas, descuentos o ausencia de riesgo |
| Facilitar compra | Recoger datos sin repetirlos, resumen y confirmación específicos; cambios requieren nueva confirmación |
| Respetar al comprador | La pregunta de cierre es opcional; aceptar «no», «lo pensaré» y despedidas; no reabrir ventas durante SAC |
| Atender reclamos | Reconocer el problema, reutilizar número/fotos y derivar directamente; no pedir una foto para justificar un doble cobro o una no entrega |
| Informar garantía | Responder política general; casos individuales requieren revisión y no se aprueban/rechazan automáticamente |
| Seguimiento | Estado y guía verificables; distinguir recibido, pagado, enviado y entregado; no prometer retención de Dropi |
| Preferencias | Registrar baja para seguimientos comerciales y carritos antes del acuse; mantener avisos de pedido y soporte |

Como referencia de calidad se usaron investigaciones de [NN/G sobre confianza, flexibilidad y traspaso humano](https://www.nngroup.com/articles/dimensions-of-ai-chatbots/), [diseño de asistentes de ecommerce](https://www.nngroup.com/articles/ai-chatbots-design-guidelines/) y [Baymard sobre claridad de devoluciones y continuidad de la experiencia](https://baymard.com/research-articles/order-returns-ecommerce-ux). La aplicación a Casa Ceiba es una propuesta de diseño, no una promesa científica de más conversión. La mejora comercial debe medirse con conversaciones reales y ventas, además de pruebas.

### Controles de código que acompañan el prompt

- Prioridad de venta/SAC solo para tiendas conectadas, sin introducir estas reglas en hotel o clínica.
- Petición inequívoca de persona deriva directamente, con acuse sin plazo inventado.
- Confirmación web reconoce recepción de la respuesta sin afirmar un guardado que aún no ocurrió ni un despacho retenido.
- Fallo al procesar confirmación/cancelación genera atención humana con contexto; no queda solo en consola.
- Cancelación que trae simultáneamente marcador de traspaso se guarda antes de salir, sin crear otra compra ni repetir derivación. Una confirmación mezclada con traspaso no confirma ni crea ventas.
- Solicitud clara de baja comercial se guarda como etiqueta `Sin promociones`, validando cuenta/contacto y sin borrar otras etiquetas. Se verifica antes de programar y antes de enviar seguimientos y carritos. Una lectura fallida retiene el envío comercial.

**Alcance de la baja:** cubre seguimientos de IA y carritos abandonados. Las rutas de broadcasts, flows y automatizaciones personalizadas todavía requieren integración de la preferencia y clasificación comercial/transaccional. El acuse nuevo explica su alcance y no promete una baja universal de todos los canales.

## Validación y publicación

Veinte escenarios con el modelo real configurado pasaron comprobaciones sobre precio, presupuesto, confianza, negativa, despedida con pedido pendiente, daño con evidencia ya enviada, doble cobro, garantía general, devolución, persona, cancelación, seguimiento, foto, compra COD confirmada, cambio de resumen, solicitud de baja, recomendación por uso/espacio, popularidad/escasez no verificadas, no entrega sin foto y reembolso sin plazo falso. Solo se generaron respuestas y propuestas con datos ficticios: no se ejecutaron acciones. Evidencia: `outputs/qa-cc-sales-service-20261114.json` y `outputs/qa-cc-sales-service-extra-20261114.json`.

La baja guardada, el fallo de guardado, la exclusión comercial y la cancelación combinada se cubren además con pruebas de integración simuladas; el ensayo del modelo por sí solo no demuestra que esas operaciones se ejecutaron.

El prompt se aplicará únicamente a Casa Ceiba mediante `scripts/apply-casa-ceiba-conversation-prompt.mjs`, después de publicar los controles acompañantes. El script por defecto muestra un plan de solo lectura; `--apply` respalda el prompt anterior, rechaza una edición concurrente mediante hash y comparación exacta, modifica solo `system_prompt` de esa cuenta y verifica la lectura posterior. No cambia modelo, precios, horarios, claves ni configuración de otra empresa.

Al crear este informe, estos nuevos cambios están preparados en rama; no se han fusionado ni aplicado al prompt vivo. La copia limpia del commit de código `d1ef601a` aprobó TypeScript, ESLint, **255 archivos / 3,068 pruebas** y el build normal de Next.js/Turbopack. El typecheck del directorio de trabajo original incluía scripts antiguos de `tmp` con errores; se verificó el snapshot limpio sin modificar esos archivos del usuario. El primer build no pudo descargar Inter por la restricción de red; al repetir con acceso de red terminó correctamente, sin cambiar fuentes ni configuración. `package-lock.json` permanece sin cambios. El script de aplicación del prompt se probó en modo plan: detecta correctamente el prompt actual y no hizo escrituras. Los cambios posteriores al commit validado son solo documentación.

## Hallazgos operativos todavía pendientes

Estos riesgos se separan del cambio de ventas/SAC y requieren trabajo técnico, no más persuasión:

1. **Pago tardío y compra cancelada/en revisión.** `recurrente-webhook/route.ts` completa el borrador antes de buscar el deal; falta una comprobación previa y persistente de elegibilidad vigente. Probar y retener un pago posterior a cancelación, una compra desvinculada o stock cambiado antes de crear el pedido importable.
2. **Retención de pago sin aviso durable al dueño.** La alerta crítica actual usa un mecanismo best-effort de plataforma; no garantiza una tarea guardada y notificada al propietario de Casa Ceiba antes de devolver 200. Hace falta persistencia y destinatario tenant explícito, además de alerta de plataforma.
3. **Rechazos de Dropify.** El aviso al equipo se somete a horario 08–20 y una clave fija puede silenciar otro rechazo del mismo pedido. Separar urgencias operativas del horario de mensajes comerciales y permitir reabrir una incidencia resuelta sin duplicar avisos.
4. **Confirmación de compra.** El resumen aceptado depende del prompt. Falta una versión persistente de artículos/total/dirección validada por el servidor para proteger frente a una propuesta equivocada del modelo.
5. **Conciliación y panel.** Todavía no hay una verificación programada completa entre dinero, pedidos y proveedor ni un panel integral de excepciones. No sustituirlo por salud HTTP.
6. **SAC completo.** Hay conversación, derivación y notificaciones, pero no un ciclo completo de tickets con propietario, vencimiento, estados, resolución y satisfacción. Reembolsos, disputas y cancelación remota continúan requiriendo operación humana autorizada. La IA no debe decir que ya los ejecutó.
7. **Prueba externa y despacho.** Falta el pedido integral controlado y confirmar el plazo real para detener un pedido en Dropi. No se cambió en esta auditoría el compromiso operativo que el propietario aceptó al activar web COD.

Prioridad siguiente: asegurar pagos retenidos y avisos al propietario, y después reconciliación/SAC operativo. Medir conversión de consulta a compra, negativa respetada, repetición de preguntas, bajas comerciales, tiempo hasta primera atención, resolución, reapertura y satisfacción. Optimizar la conversión sin sacrificar esas métricas de servicio.
