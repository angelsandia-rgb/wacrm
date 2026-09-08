# Auditoría WACRM y kit de hotel — 7 de septiembre de 2026

## Alcance y estado

Revisión del código de reservas, tarifas, catálogo público, contexto y recuperación de IA,
métricas hoteleras, migraciones de aislamiento, dependencias, pruebas y configuración de
despliegue. Inspección de EasyPanel y Supabase autorizada por el propietario, en modo de
lectura. Las observaciones remotas se tomaron la noche del 7 de septiembre en Guatemala
(8 de septiembre UTC). No se descargaron conversaciones ni claves en este informe.

Los cambios de esta auditoría se publicaron en `origin/main` para el despliegue automático
de EasyPanel. No se compraron planes ni se modificó la carpeta preexistente `docs/prompts/`.
La migración 119 se aplicó en Supabase el 8 de septiembre de 2026 después de comprobar que
no existían referencias entre empresas, valores inválidos ni tarifas solapadas. La ejecución
fue transaccional y quedó registrada en `supabase_migrations.schema_migrations`.

Esto es una revisión con correcciones y evidencia, no una certificación de ausencia de
vulnerabilidades. No se ejecutaron ataques ni pruebas de carga contra clientes reales.

## Hallazgos corregidos

| ID | Prioridad | Problema reproducible | Corrección y evidencia |
|---|---|---|---|
| H01 | Alta | POST/PATCH de reservas con service role permitían referencias de otras empresas; RLS de la reserva no validaba la pertenencia de sus claves foráneas. | Validador compartido consulta contacto, conversación, producto y cotización con `account_id`. Pruebas de rechazo para las cuatro referencias. Migración 119 añade un trigger para las escrituras directas. |
| H02 | Alta | Un cuerpo público con `name: {}` o `phone: []` provocaba una excepción al llamar `trim()`. Un token de conversación numérico llegaba al verificador de cadenas. | Comprobación de tipos y longitudes antes de acceder a la BD. Pruebas HTTP: respuesta 400 sin acceder a Supabase. |
| H03 | Alta | La estadía de más de 366 noches se cotizaba como 366, sin avisar del recorte. JavaScript normalizaba fechas como 30 de febrero. | Validación real del calendario y rechazo completo de rangos fuera de 1–366 noches. Se comparte con temporadas, formulario y reservas. Pruebas de año bisiesto y límites. |
| H04 | Alta | La IA podía escoger la primera habitación cuyo nombre contuviera un texto ambiguo; suponía dos huéspedes cuando no se habían informado. | No producir estimación si el nombre coincide con varios productos o falta una ocupación válida. Pruebas de ambas condiciones. |
| H05 | Alta | La consulta de estimaciones decía buscar pendientes, pero no filtraba estado; una suma parcial se presentaba como total. | Filtro `status = pending`; las noches con huecos se presentan como subtotal y no se guardan como total completo. |
| H06 | Media | El catálogo ocultaba tarifas cero, pero el cálculo podía interpretarlas como noches gratis. Tarifas solapadas podían depender del orden de las filas. | Tarifas no positivas/no finitas se consideran ausentes; precios distintos que coinciden para la misma noche resultan indeterminados, sin bajar silenciosamente a una ocupación más barata. |
| H07 | Media | Lectura seguida de inserción de reservas fallaba ante dos solicitudes simultáneas con la misma conversación/categoría. | Ante `23505`, una sola recuperación busca la fila ganadora y combina únicamente los campos suministrados, limitada a la empresa. Prueba del conflicto. |
| H08 | Media | Métricas limitadas a una consulta de 5,000 filas, susceptible al máximo de PostgREST; errores se convertían en arrays vacíos. | Paginación por ID para reservas, productos y categorías; errores visibles con reintento. Prueba con 1,205 filas y un servidor simulado que devuelve solo 100 por consulta. |
| H09 | Media | Servicios creados antes del período, pero utilizados dentro de él, podían quedar fuera del panel. | El filtro también considera `use_date`. |
| H10 | Media | Cantidades fuera del entero PostgreSQL y fechas inválidas acababan en errores de base de datos. | Validación compartida para nuevas reservas y modificaciones; trigger comprueba también el rango final de actualizaciones parciales. |
| H11 | Rendimiento | La IA contaba todos los fragmentos de conocimiento solo para saber si existía alguno. | Consulta `select id limit 1`, filtrada por empresa. Conserva la recuperación semántica/lexical y evita un conteo proporcional al volumen. |
| H12 | Rendimiento / resiliencia | Cuatro fuentes independientes de contexto se consultaban en serie; una excepción impedía cargar las posteriores. | `Promise.allSettled` para conocimiento, etapas comerciales, catálogo y respuestas rápidas. Se conservan fuentes exitosas y el aviso de fallo. Prueba: caída de conocimiento no elimina el catálogo del prompt. |
| H13 | Rendimiento | Listado de reservas y filtro histórico sin índices compuestos específicos. | Migración 119 incluye índices por empresa con `created_at`, `check_out` y `use_date`. Beneficio pendiente de medir con EXPLAIN en staging/producción. |
| H14 | Alta | `product_rates.account_id` no garantizaba que `product_id` perteneciera a la misma empresa; las temporadas solapadas eran aceptadas y podían devolver un precio dependiente del orden. | Validación de solapamiento al guardar y resolución segura al leer. La migración 119 verifica la empresa del producto y rechaza tarifas base duplicadas o temporadas superpuestas. Pruebas TypeScript y PostgreSQL. |
| H15 | Alta | Docker y CI seguían fijados en Node 20, una rama fuera de soporte y sin nuevas correcciones de seguridad. | Runtime, build, CI y requisito del paquete actualizados a Node 24 LTS. |
| H16 | Alta | La auditoría de npm reportó siete dependencias vulnerables, incluidas dos altas (`browserslist` y `fast-uri`). | Lockfile actualizado; `fast-uri` corregido y `uuid` de ExcelJS fijado a una versión corregida compatible. La auditoría final reporta cero vulnerabilidades. |
| H17 | Media | Otras dos rutas públicas (`quote-request` y solicitud de cuenta) podían lanzar excepciones al recibir objetos o arreglos donde esperaban texto; el carrito no se acotaba antes de procesarlo. | Guardas de tipo y longitud, límite de 100 líneas y pruebas que confirman respuesta 400 sin acceso a BD ni envío de correo. |

Las reservas almacenadas se inspeccionaron con un conteo agregado: **0 referencias entre
empresas** entre las cinco reservas existentes. Esto no prueba que no haya habido intentos
anteriores ni sustituye la corrección H01.

## Infraestructura comprobada

| Recurso | Observación directa |
|---|---|
| VPS / EasyPanel | Contabo, plan de USD 8 informado por el propietario; 4 núcleos; 7.8 GB RAM; 95.8 GB disco |
| Utilización puntual del VPS | CPU 0.8%; RAM 2.1 GB (26.9%); disco 12.4 GB (13%) |
| Proceso CRM en EasyPanel | Una lectura mostró 65.9 MB de memoria; no representa su pico al generar PDF o procesar imágenes |
| Supabase | Organización Free; proyecto Sandia; cómputo Nano / t3a.nano; región Oregon `us-west-2` |
| Salud puntual Supabase | Healthy; CPU 5%; RAM 66%; 17/60 conexiones; disco 17% |
| Disco físico de la instancia de BD | API: 2 GB gp3, 3,000 IOPS, 125 MiB/s. No equivale a la cuota de datos del plan Free |
| Copias programadas | La vista del proyecto muestra “No backups” |
| Empresas / hoteles | 3 / 1 |
| Contactos / conversaciones | 450 / 423 |
| Mensajes almacenados | 6,844 |
| Mensajes últimas 24 horas / 7 días | 424 / 1,708; incluyen todas las clases de remitentes |
| Reservas / productos | 5 / 24 |
| Fragmentos de conocimiento | 26 |
| Base de datos total | 46,566,547 bytes = 46.57 MB decimales = 44.41 MiB |
| Tabla messages con índices | 6,389,760 bytes; unos 934 bytes por mensaje en esta muestra |

La RAM de la aplicación y la RAM de PostgreSQL son recursos separados. Aumentar el VPS
no aumenta el Nano de Supabase. Los 60 enlaces PostgreSQL tampoco equivalen a 60 empresas
ni a 60 agentes: PostgREST y el pool comparten conexiones.

## Cuánta data y cuántas empresas

**No existe un número máximo de empresas deducible de la RAM del VPS.** Importan los
mensajes por segundo en pico, tamaño del catálogo, imágenes/PDF, agentes conectados,
tokens por respuesta, retención y cuotas de terceros. La utilización actual corresponde
a tres empresas y poca carga; no se extrapola como una prueba de 100 empresas.

La documentación vigente de Supabase señala para Free 500 MB de BD, 1 GB de archivos y
Nano con hasta 0.5 GB de RAM. Hay cuotas separadas de transferencia. A partir de los
46.57 MB medidos queda una diferencia nominal de unos **453 MB de base de datos**; no
conviene utilizarla completa ni confundirla con espacio para videos o fotografías.

Para planear: reservar 30% de la cuota deja unos **303 MB de presupuesto incremental**.
La muestra de messages es pequeña y no incluye el crecimiento de contactos, índices de
otras tablas, logs, vectores o bloat. Usar provisionalmente **2–4 KiB por mensaje** para
datos y registros relacionados, excluyendo archivos, resulta más prudente. Es una hipótesis
de planificación que debe recalibrarse con mediciones semanales.

Con 180 días de retención:

| Mensajes por empresa/día | Crecimiento por empresa a 2–4 KiB | Empresas adicionales que cabrían solo por ese presupuesto de almacenamiento |
|---|---|---|
| 30 | 11.1–22.1 MB | 13–27 |
| 100 | 36.9–73.7 MB | 4–8 |
| 300 | 110.6–221.2 MB | 1–2 |

Esta tabla **no garantiza capacidad de procesamiento**. En particular, campañas con
cientos de respuestas simultáneas pueden agotar límites de IA aunque el disco esté vacío.
La fecha real de retención configurada debe verificarse antes de usar esta proyección;
180 días es una hipótesis, no un cambio aplicado.

Proyección alternativa a 100 mensajes/empresa/día, 180 días y 2 KiB/mensaje:

| Empresas | Mensajes/día | Datos incrementales retenidos |
|---|---|---|
| 10 | 1,000 | 0.37 GB |
| 25 | 2,500 | 0.92 GB |
| 50 | 5,000 | 1.84 GB |
| 100 | 10,000 | 3.69 GB |

Duplicar esas cifras usando 4 KiB. Agregar archivos y base existente por separado.
Para clientes de pago, priorizar copias verificadas y salir de Free antes de vender una
capacidad grande. Con Pro y cómputo adecuado, **25–50 empresas pequeñas** es un objetivo
para una primera prueba de carga, no una capacidad ya validada. No se compró ningún plan.

Fórmulas para recalcular:

```text
BD incremental = empresas × mensajes diarios × días retenidos × bytes efectivos/mensaje
Archivos = archivos/día × tamaño medio × días retenidos
Concurrencia IA aproximada = solicitudes IA/segundo × segundos por solicitud
Techo efectivo = mínimo(BD, CPU/RAM, colas, Realtime, RPM/TPM IA, mensajería, presupuesto)
```

## IA: límites y tiempos

- `aiContextMessageLimit`: 20 mensajes de contexto por defecto. Guardar más historia no
  hace que toda esa historia entre en cada respuesta.
- `catalog-context.ts`: solo 30 productos en el prompt, ordenados por nombre. Un catálogo
  grande necesita búsqueda de productos por intención y filtros, no aumentar sin límite
  el prompt. Actualmente un producto fuera de esos 30 puede quedar fuera de recomendaciones.
- Recuperación de conocimiento: hasta cinco fragmentos por defecto; bloques de unos 1,200
  caracteres. Más documentos pueden mejorar cobertura, pero textos contradictorios o
  duplicados pueden empeorar respuestas. Mantener políticas, vigencias y tarifas coherentes.
- Espera deliberada `AI_DEBOUNCE_MS`: 30,000 ms por defecto. Timeout por consulta de modelo:
  40,000 ms. La ruta tiene reintentos ante fallos transitorios; varias esperas pueden sumar
  más de dos minutos. No confundir timeout individual con plazo total de atención.
- H12 reduce la parte secuencial de cuatro fuentes de aproximadamente la suma de sus
  tiempos al máximo de ellos. No se adjudica un porcentaje de mejora sin medición real.
- El debounce vive en memoria de un proceso. Antes de dos réplicas hace falta un estado
  compartido y una cola persistente por conversación; de lo contrario puede haber respuestas
  dobles y trabajo perdido al reiniciar.
- Para bajar la espera, probar 8–12 segundos de debounce con conversaciones sintéticas y
  medir duplicados/interrupciones. No se cambió la configuración comercial de producción.

## Riesgos pendientes y decisiones de producto

1. **Copias y recuperación.** La vista remota no muestra backups programados. Establecer
   backup de BD y archivos con retención, cifrado, acceso restringido y ensayo de restauración.
   Una copia que nunca se ha restaurado no demuestra recuperabilidad.
2. **Administración por HTTP.** La sesión de EasyPanel observada usa HTTP sobre IP pública.
   Migrar el acceso administrativo a HTTPS y restringirlo con red privada/VPN o acceso
   controlado. No se cambió el endpoint durante esta revisión para evitar cortar el acceso.
3. **No hay inventario hotelero físico.** `roomCount` cuenta productos activos de categoría
   habitaciones. Si “Suite Deluxe” representa diez unidades, ese conteo no es capacidad
   real. Ocupación, ADR y RevPAR son aproximaciones de solicitudes/precios estimados;
   incluyen pendientes no denegadas. No son contabilidad ni disponibilidad confirmada.
4. **No hay protección contra sobreventa.** `reservation_requests` es un registro de
   solicitudes, no un motor de inventario, pagos y bloqueo transaccional por habitación/noche.
   Mantener confirmación humana hasta implementar ese modelo o integrar un PMS.
5. **Una solicitud por conversación/categoría.** El índice actual impide múltiples viajes
   independientes de la misma categoría en un solo hilo. Hace falta separar intención activa,
   historial de estadías, cancelación y confirmación. No cambiar ese contrato de datos sin
   migración y adaptación de Sheets/IA.
6. **Precios persistidos.** `estimated_price` puede venir de captura manual, cotización o
   propuesta de IA; todavía no tiene procedencia/versionado. Una modificación de fechas o
   tarifas puede dejar un importe anterior. El cálculo compartido mejora el contexto, pero
   hace falta un servicio único de cotización con versión, moneda y detalle por noche.
7. **Métricas grandes.** El paginador tiene un límite defensivo de 50,000 filas por conjunto;
   al superarlo muestra error en lugar de cifras parciales. Antes de ese volumen, trasladar
   agregados a SQL por empresa/período y evitar mandar el libro entero al navegador.
   La paginación no ofrece una instantánea transaccional durante modificaciones concurrentes.
8. **Modelo y herramientas.** Seguir tratando respuestas como propuestas: autorización,
   pertenencia de empresa, validación e idempotencia en servidor. No usar prompts como
   sustituto de controles. Añadir evaluaciones hoteleras con fechas, tarifas faltantes,
   cambios de fechas, instrucciones maliciosas, fallos de proveedor y respuesta humana.
9. **Rate limits y reintentos.** El exceso de cuota de autoreply puede omitir una respuesta
   automática. Una cola por empresa con presupuestos de RPM/TPM y alerta de antigüedad es
   necesaria para escalar sin depender del agente humano que vea el inbox.
10. **Base de conocimiento.** La reindexación aún borra chunks antes de reinsertar; una
    caída entre ambos pasos puede dejar un documento sin índice. Migrar a reemplazo
    transaccional/versionado y probar lecturas durante reindexación.

El asesor de seguridad de Supabase reportó avisos sobre `vector`/`pg_net` en public y
protección de contraseñas filtradas desactivada. También reportó RPC SECURITY DEFINER y
tablas de uso interno con RLS sin políticas. No se revocaron esos permisos en bloque:
funciones como `is_account_member` son necesarias para RLS y los procesos internos usan
service role. Los avisos requieren revisión según función, no una eliminación automática.

## Plan para crecer

### Antes de aumentar ventas

Mantener las correcciones bajo CI y ensayar migraciones futuras en staging. Hacer backup y
restauración en staging. Proteger EasyPanel. Definir retención real, alertas de cuotas y
presupuesto por empresa. Documentar claramente que la reserva necesita confirmación.

### Primera etapa: validar 10, 25 y 50 empresas

Preparar datos sintéticos por empresa, agentes simultáneos y carga representativa de
mensajes, imágenes, consultas de catálogo y PDF. Usar proveedores de mensajería simulados;
no enviar WhatsApp de prueba a clientes. Medir durante 30–60 minutos por escalón, incluyendo
ráfagas de 5–10 veces el promedio y un reinicio del worker.

Objetivos iniciales a ajustar al negocio: webhook aceptado p95 <1 s, lectura API p95
<500 ms, errores <1%, ningún cruce de empresa, ninguna acción duplicada y recuperación del
trabajo pendiente después de reiniciar. Separar latencia del modelo, debounce, red y BD.
Detener el escalón si hay pérdida de mensajes, colas crecientes o memoria sostenida >75%.
No se ejecutó esta prueba contra producción.

### Segunda etapa: eliminar límites estructurales

Cola persistente, workers independientes y concurrencia/cuotas por empresa; debounce
compartido; agregados SQL para métricas; búsqueda de productos; carga de documentos con
límites y reindexación transaccional. Inventario hotelero/PMS y cotización determinista
versionada. Instrumentar trazas desde webhook hasta envío con identificador de correlación.

### Operación mensual

Revisar costo por empresa (IA, mensajes, almacenamiento, soporte), tiempos p50/p95/p99,
errores del proveedor, antigüedad de cola, duplicados, tasa de intervención humana y
restauraciones verificadas. Dimensionar por esos resultados antes de añadir réplicas.

## Reproducción y fuentes

`scripts/audit-capacity.sql` devuelve solo conteos y tamaños agregados; el script PowerShell
lo envía al endpoint read-only con un token ya disponible en el entorno. No almacena tokens.
En máquinas con política de scripts restrictiva se puede usar el SQL en la consola
administrativa, sin cambiar la política global de Windows.

Fuentes oficiales consultadas el 7 de septiembre de 2026:

- [Cuotas y planes Supabase](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Cómputo, RAM y conexiones](https://supabase.com/docs/guides/platform/compute-and-disk)
- [Diferencia entre base de datos y disco](https://supabase.com/docs/guides/platform/database-size)
- [Consultas de solo lectura por API](https://supabase.com/docs/reference/api/v1-read-only-query)
- [Límite de filas del cliente](https://supabase.com/docs/reference/javascript/select)
- [Aviso uuid y versiones corregidas](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq)
- [Ciclo de soporte oficial de Node.js](https://nodejs.org/en/about/previous-releases)

## Validación de entrega

La línea base pasó 155 archivos / 1,630 pruebas. El estado final pasó:

- `npm test -- --reporter=dot`: **163 archivos / 1,683 pruebas**.
- `npm run typecheck`: sin errores.
- `npm run lint`: sin errores.
- `npm run build`: compilación de producción correcta con Next.js 16.2.12; TypeScript y
  generación de las 108 páginas completadas.
- `npm audit`: **0 vulnerabilidades**.
- Migración 119 ejecutada en PostgreSQL embebido PGlite: aislamiento de reservas,
  validación de valores y coherencia/solapamiento de tarifas comprobados.
- Migración 119 aplicada en Supabase producción y registrada como
  `20260908082637 / 119_reservation_tenant_guard`. Verificación posterior: dos funciones,
  dos triggers, tres índices, cinco reservas y quince tarifas; ninguna fila se perdió.
- `git diff --check`: sin errores de whitespace.

Los mensajes escritos en `stderr` durante Vitest corresponden a escenarios deliberados de
fallo, reintento y recuperación; la suite terminó con código de salida cero.
