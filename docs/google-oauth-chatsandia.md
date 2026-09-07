# Google OAuth de Chat Sandía (Sheets + Calendar) — manual de operación

La integración con **Google Sheets** (exportar filas del CRM a una hoja) y con
**Google Calendar** usa **un solo cliente OAuth 2.0** en el proyecto de Google
Cloud **`chat-sandia`**. Este documento cubre cómo mantenerlo y cómo conecta
cada empresa su hoja.

## Datos fijos

| Cosa | Valor |
|---|---|
| Proyecto Google Cloud | `chat-sandia` (número `914913293424`) |
| Cliente OAuth | `914913293424-n0t6fs2lc3g17lo693qdjq2uag16b1f4.apps.googleusercontent.com` |
| Página del cliente OAuth | `https://console.cloud.google.com/auth/clients/914913293424-n0t6fs2lc3g17lo693qdjq2uag16b1f4.apps.googleusercontent.com?project=chat-sandia` |
| Página de público / usuarios de prueba | `https://console.cloud.google.com/auth/audience?project=chat-sandia` |
| URL de retorno (Sheets) | `https://chatsandia.com/api/google-sheets/oauth/callback` |
| URL de retorno (Calendar) | `https://chatsandia.com/api/google-calendar/oauth/callback` |
| Cómo se arma esa URL | `${NEXT_PUBLIC_SITE_URL}/api/google-sheets/oauth/callback` — `NEXT_PUBLIC_SITE_URL` en EasyPanel = `https://chatsandia.com` |
| Permiso que pide Sheets | `https://www.googleapis.com/auth/spreadsheets` (sensible) + `userinfo.email` |
| Estado de publicación | **Testing** — solo los correos en "Usuarios de prueba" pueden autorizar |
| Tope de usuarios | 100 de por vida del proyecto; no se reinicia; los eliminados siguen contando |

---

## 1. Error `redirect_uri_mismatch` (resuelto 2026-09-07)

**Causa:** al cambiar el dominio de EasyPanel a `chatsandia.com`, el cliente
OAuth solo tenía registradas las URLs de retorno del dominio viejo.

**Arreglo (ya aplicado):** en la página del cliente OAuth → **Authorised
redirect URIs** se agregaron:

- `https://chatsandia.com/api/google-sheets/oauth/callback`
- `https://chatsandia.com/api/google-calendar/oauth/callback`

y en **Authorised JavaScript origins**: `https://chatsandia.com`.
(Se dejaron también las 2 URLs viejas de `*.easypanel.host`; no estorban.)

**Si vuelve a pasar** (p. ej. otro cambio de dominio): abre la página del
cliente OAuth, agrega la URL exacta que la app envía (aparece en el detalle
del error de Google, campo `redirect_uri`), Guarda. Propaga en 1–5 minutos.

---

## 2. Conectar la hoja de una empresa

1. Entra al CRM como la empresa → **Configuración → Google Sheets → "Conectar
   Google Sheets"**.
2. En Google, **elige la cuenta de Google** dueña de la hoja de esa empresa.
   - Esa cuenta debe estar en la lista de **usuarios de prueba** (ver §3). Si
     no está: "Acceso bloqueado: Chat Sandía no completó el proceso de
     verificación de Google" → agrégala primero.
3. Pantalla de permisos → **Continuar / Permitir** ("Ver, editar, crear y
   borrar tus hojas de cálculo de Google").
4. Vuelve al CRM → debe decir **"Conectado"**.
5. Activa el evento que corresponda (para hoteles: la solicitud de reserva /
   `reservation.updated`) y define la hoja base. Las pestañas por categoría se
   crean solas en el primer registro.

> Como la app está en **Testing** con usuarios de prueba, los correos de la
> lista **no** ven ninguna advertencia de "app no verificada" — el flujo es
> limpio.

---

## 3. Usuarios de prueba (testers)

Página: `https://console.cloud.google.com/auth/audience?project=chat-sandia`
→ sección **Test users**.

**Agregar** (o usa la skill `add-oauth-tester`):

1. "+ Add users".
2. Escribe el correo. **No dependas de la tecla Enter** (la bloquea el
   clasificador de automatización, y el autocompletar del navegador puede
   meter otro correo). En su lugar: escribe → clic en **Save** una vez (el
   texto se vuelve un "chip", el contador pasa a `1 / …`) → **verifica que el
   chip diga el correo correcto** → clic en **Save** otra vez.
3. Recarga la página y confirma que aparece en la lista.

**Estado actual de la lista** (2026-09-07):

- `angelduran.contact@gmail.com`
- `angelduran.management@gmail.com`
- `durandavidinma1@gmail.com`
- `pixel5ilim@gmail.com` (cuenta DEMO / hotel)

**Quitar un tester:** ícono de basurero → Confirm. Un tester eliminado **sigue
contando** contra el tope de 100 y ya no podrá autorizar hasta que se vuelva a
agregar o la app pase a producción. No quites correos que no agregaste tú sin
confirmarlo con el dueño.

---

## 4. Volver a producción / verificar la app (a futuro)

Mientras esté en **Testing**: hay que agregar a mano el correo de cada empresa
y el tope es 100.

Para que **cualquier** cuenta conecte sin advertencia y sin tope:

1. **Audience → "Publish app"** (vuelve a producción). En producción sin
   verificar, los usuarios ven una vez la pantalla "Google no ha verificado
   esta aplicación" → "Configuración avanzada" → "Ir a Chat Sandía (no
   seguro)" → Continuar. Funciona, solo se ve feo (tope 100 para scopes
   sensibles).
2. Para quitar esa pantalla: **Branding** (nombre, logo, dominio
   `chatsandia.com`, enlaces a política de privacidad y términos) →
   **Verification centre → "Submit for verification"**. Google pide un video
   corto del flujo de consentimiento; la revisión tarda de días a ~2 semanas.

---

## 5. Cambiar entre Testing y Producción — cuidado

El cliente OAuth es **compartido** por Sheets y Calendar. Cambiar el estado de
publicación afecta a **ambos**:

- **Testing:** solo los testers pueden autorizar o **re-autorizar**. Si una
  cuenta que ya tenía Calendar conectado (p. ej. Chat Sandia) necesita
  re-autorizar y no está en la lista, se bloquea. Por eso
  `angelduran.management@gmail.com` está en la lista.
- **Producción:** cualquiera autoriza, con la pantalla de "no verificada"
  hasta que Google verifique la app.
