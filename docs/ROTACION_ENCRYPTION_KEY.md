# Rotación de `ENCRYPTION_KEY` — plan

**Estado:** planificado, **no ejecutado**. Redactado el 2026-09-23.

**Motivo:** EasyPanel pasa todos los secretos como `--build-arg`, así que
aparecen en texto plano en la lista de procesos del VPS durante cada build.
Además quedaron en el registro de una sesión de Claude Code. **No** quedan en
las capas de la imagen: el Dockerfile solo declara `ARG` para las
`NEXT_PUBLIC_*`, y se verificó con `docker history` / `docker image inspect`.

> Nunca pegar claves en este documento, en un PR ni en un chat.

---

## 1. Qué protege la clave

`src/lib/whatsapp/encryption.ts` cifra con AES-256-GCM
(`<iv>:<ciphertext>:<tag>`). Todavía descifra el formato CBC antiguo
(`<iv>:<ciphertext>`), aunque hoy no queda ninguno.

Inventario en producción al 2026-09-23 (conteo sin leer valores):

| Tabla | Columnas | Valores |
|---|---|---|
| `ai_configs` | `api_key`, `embeddings_api_key` | 3 + 1 |
| `whatsapp_config` | `zernio_api_key`, `zernio_webhook_secret` | 2 + 2 |
| `instagram_config` | `zernio_api_key`, `zernio_webhook_secret` | 1 + 1 |
| `facebook_config` | `zernio_api_key`, `zernio_webhook_secret` | 1 + 1 |
| `google_calendar_config` | `access_token`, `refresh_token` | 2 + 2 |
| `google_sheets_config` | `access_token`, `refresh_token` | 2 + 2 |

**Total: 20, todos GCM.** El código también cifra estas columnas, vacías
hoy; el script debe cubrirlas igual: `webhook_endpoints.secret`,
`whatsapp_config.access_token` / `verify_token` e
`instagram_config.access_token` / `verify_token`.

No usan esta clave: `api_keys` (hash SHA-256) ni las claves de la API v1.

La misma clave firma los enlaces de catálogo con HMAC
(`src/lib/products/catalog-link-token.ts`, parámetro `?c=`). Si la firma no
valida, el enlace sigue funcionando: resuelve el contacto por teléfono en vez
de por conversación.

Para repetir el inventario antes de ejecutar, contar por columna los valores
que coinciden con `^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$` (GCM) y
`^[0-9a-f]{32}:[0-9a-f]+$` (CBC).

**Rotar la clave no cambia los secretos:** solo vuelve a cifrar el valor
guardado. Las claves de IA, las de Zernio y los tokens de Google siguen
siendo los mismos, así que no hay que reconectar nada.

## 2. Por qué no basta con cambiar la variable

`encryption.ts` usa **una sola clave**. Si se cambia `ENCRYPTION_KEY` y se
despliega, los 20 valores dejan de descifrarse al instante: la IA se apaga,
los envíos por Zernio fallan y Calendar y Sheets se desconectan.
`src/lib/ai/config.ts` ya registra el error ("could not be decrypted —
check ENCRYPTION_KEY"), pero no lo evita.

## 3. Fase 1 — Código (PR previo; no toca producción)

1. **`encryption.ts`:**
   - `encrypt()` sigue usando siempre `ENCRYPTION_KEY`.
   - `decrypt()` prueba `ENCRYPTION_KEY` y, si la verificación GCM falla,
     reintenta con `ENCRYPTION_KEY_PREVIOUS` cuando esté definida. El tag
     de GCM distingue la clave correcta sin ambigüedad, así que el formato
     no cambia.
   - Tests: descifra con la actual, con la anterior, y falla con cualquier
     otra.
2. **`catalog-link-token.ts`:** la verificación acepta una firma hecha con
   cualquiera de las dos claves.
3. **Script `scripts/rotate-encryption-key.ts`:**
   - Recorre las 12 columnas con datos y las 5 vacías de la sección 1.
   - Descifra con la clave anterior, vuelve a cifrar con la nueva y
     actualiza fila por fila, por `id`.
   - Modo `--dry-run`.
   - Es idempotente: salta lo que ya descifra con la nueva.
   - Termina con un conteo de verificación.
   - Recibe las claves y la service role **por variables de entorno**
     (`OLD_ENCRYPTION_KEY`, `NEW_ENCRYPTION_KEY`), nunca por argumento ni
     archivo.
4. **`/api/health`:** agregar el chequeo `encryption`, que descifra un valor
   real. Así UptimeRobot detecta una clave equivocada.

## 4. Fase 2 — Operación en producción

1. **EasyPanel:** mover todos los secretos a variables **de ejecución**;
   como build-args solo quedan las `NEXT_PUBLIC_*`. Hacerlo primero, para
   que la clave nueva nunca aparezca en la lista de procesos.
2. **Generar la clave nueva localmente** con `openssl rand -hex 32` y
   guardarla en el gestor de contraseñas.
3. **EasyPanel:** poner `ENCRYPTION_KEY` = nueva y
   `ENCRYPTION_KEY_PREVIOUS` = actual, y desplegar. Todo sigue
   funcionando: lo viejo se descifra con la anterior y lo nuevo se escribe
   con la nueva.
4. **Correr el script** en seco y luego en real. Debe reportar todos los
   valores migrados (20 al 2026-09-23).
5. **Pruebas:**
   - Enviar un WhatsApp desde el inbox.
   - Esperar una respuesta automática de la IA.
   - Abrir `/calendar`.
   - Forzar una fila en Google Sheets.
   - Instagram y Facebook, si están conectados.
   - `/api/health` con `encryption: ok`.
6. **Esperar un día.** Luego quitar `ENCRYPTION_KEY_PREVIOUS` y volver a
   desplegar; desde ahí la clave vieja deja de servir.

**Si algo falla** antes del paso 6, basta con intercambiar los valores de
`ENCRYPTION_KEY` y `ENCRYPTION_KEY_PREVIOUS` y volver a desplegar; nada
queda ilegible.

## 5. Rotaciones relacionadas (misma exposición)

La clave se expuso **junto con** `SUPABASE_SERVICE_ROLE_KEY`, y con las dos
se puede leer y descifrar todo. Rotar solo `ENCRYPTION_KEY` no alcanza. En
este orden:

1. **Service role key de Supabase.** Con las claves JWT antiguas no se
   rota sola: se rota el JWT secret y cambia también la anon key, lo que
   obliga a reconstruir la app con la nueva
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`. La alternativa es migrar a las claves
   API nuevas de Supabase (publishable y secret), que se rotan por
   separado.
2. **Contraseña de aplicación de Gmail** (`SUPPORT_` / `PAYMENTS_GMAIL_APP_PASSWORD`)
   y **client secret de Google OAuth** (Calendar y Sheets comparten
   cliente). No afectan datos guardados.
3. **Secretos de cron, VAPID y `META_APP_SECRET`.** Los secretos de cron
   se cambian a la vez en EasyPanel y en los `cron.job` de pg_cron (ver
   RUNBOOK §6). Rotar VAPID invalida las suscripciones push existentes.

Riesgo al 2026-09-23: acotado. La exposición fue al registro local de una
sesión y a quien tenga acceso root al VPS, no a internet.
