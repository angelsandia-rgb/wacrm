# Cesi: enganches humanos y productos nuevos

14 de noviembre de 2026, horario de Guatemala.

## Prompt ya aplicado

El propietario pidió un enganche cálido y vendedor para todos los productos, manteniendo la venta en caliente 70/30. Se añadió al prompt operativo de Casa Ceiba la regla de convertir una característica real del producto en un beneficio cotidiano, dar el precio y proponer el siguiente paso con naturalidad.

La prueba social («más vendido», «favorito de los clientes») requiere datos verificables por producto; el catálogo actual no aporta ese ranking. El enganche funciona con atributos reales sin inventar ventas, reseñas o escasez. No usa el mismo adjetivo ni el guion del sofá para todos los artículos. SAC y negativas conservan prioridad.

Ejemplos observados en el ensayo:

- Sofá: «El Sofá Inflable le da un espacio cómodo para relajarse donde quiera. Está a Q400… ¿Le preparo el pedido?»
- Dispensador: «El Dispensador de Agua Recargable le ayuda a servir su agua sin voltear el garrafón…»
- Afeitadora: «La Afeitadora Eléctrica Portátil le ayuda a arreglarse rápido donde esté…»

Se aplicó solo system_prompt de Casa Ceiba con respaldo y comparación de la revisión actual; coincidencia exacta verificada a las **06:18:58 Guatemala**. Modelo, habilidades, asesor, activación y demás ajustes preservados.

Snapshot vigente: `docs/prompts/casa-ceiba-system-prompt-2026-11-14-enganches.md`.

SHA256 del prompt normalizado: `f9be142773a7dd3aecd4b4665109c7c7fa7bae6deb1a93f43bf720b3336ff7a8`.

QA: 11 casos con el modelo real, incluidos tres productos actuales de categorías diferentes, producto nuevo ficticio con ficha, producto nuevo sin descripción, popularidad no acreditada, intento de forzar un ranking, compra decidida, negativa, SAC y foto. Pasaron sin enviar mensajes, cobrar ni ejecutar propuestas. El ensayo usa las descripciones de 80 caracteres del runtime previo y no depende del nuevo código aún pendiente de publicar. Evidencia local: `outputs/qa-cesi-enganches-humanos-v3-20261114.json` y `outputs/actualizacion-cesi-enganches-humanos-20261114.json`.

## Refuerzo de catálogo preparado para publicación

La IA recibía solo los primeros 50 productos por orden alfabético, con descripciones de tienda recortadas a 80 caracteres. Esa limitación podía dejar fuera una incorporación futura o su beneficio principal.

El cambio de código conserva un contexto final de hasta 50 productos y busca nombres relevantes en la base de datos cuando el catálogo alcanza ese tamaño. Las consultas adicionales también están limitadas a 50, con cuenta y activos obligatorios. Se sanea la entrada, se admiten tildes y se prioriza el producto nombrado sobre coincidencias genéricas. No se carga el catálogo entero en el prompt.

La búsqueda usa hasta cuatro turnos recientes, con la consulta más reciente primero. Así el producto recuperado se mantiene cuando la siguiente respuesta del cliente es «sí» o «lo quiero», y una nueva selección puede reemplazar a la anterior. Auto-reply y playground usan el mismo criterio.

Las descripciones dropshipping pasan a hasta 300 caracteres, que es lo conservado por la sincronización; hoteles mantienen sus 1,200 caracteres y reglas de tarifas/capacidad. Los negocios genéricos conservan 80.

Pruebas específicas: producto fuera de los primeros 50, continuidad tras confirmación breve, cambio de producto, aislamiento de cuenta/activos, entrada con sintaxis de filtro, búsqueda no disponible, límites y restricciones del hotel. No son una garantía de reconocer cualquier error ortográfico o nombre ambiguo: si no puede identificar el producto, la IA debe preguntar y no inventar.

El prompt de enganches **ya está activo**. El refuerzo de recuperación del catálogo **requiere publicar el nuevo PR** y no debe describirse como desplegado todavía. Los demás riesgos de pagos/conciliación de la auditoría continúan fuera del alcance de este cambio.

Validación del código (`11011199`, posterior al ajuste de fixtures): TypeScript y ESLint sin errores; 255 archivos / **3,078 pruebas aprobadas**; build normal de Next.js/Turbopack aprobado con 143 páginas; package-lock.json sin cambios. La sintaxis de búsqueda se comprobó además con una consulta real de solo lectura, recuperando Sofá Inflable aun usando patrones sin tildes. Los documentos añadidos después de esa validación no cambian el código probado. Graphify mantiene el fallo conocido de uv.
