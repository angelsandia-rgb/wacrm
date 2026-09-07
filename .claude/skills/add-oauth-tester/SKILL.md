---
name: add-oauth-tester
description: >-
  Add (or remove) a Google account as a TEST USER on the Chat Sandía Google
  OAuth app so that account can connect Google Sheets / Google Calendar in the
  CRM without hitting the "Google hasn't verified this app" warning. Use when a
  new company/hotel needs to link its Google Sheet, when the user says "agrega
  X como tester / usuario de prueba", or when someone reports "Acceso
  bloqueado" / "app no verificada" on the Google consent screen. Google Cloud
  project is `chat-sandia`; driven via Claude in Chrome browser automation.
metadata:
  author: session-derived
  version: "1.0.0"
  source: wacrm Google Sheets OAuth fix (Chat Sandía / chatsandia.com), 2026-09-07
---

# Add a Google OAuth test user (Chat Sandía)

Chat Sandía's Google integration (Sheets export + Calendar) uses **one shared
OAuth 2.0 client** in the Google Cloud project **`chat-sandia`**. That app is
in **Testing** publishing status, so **only email addresses on the "Test
users" list can complete the OAuth flow** — anyone else is hard-blocked with
"Acceso bloqueado: Chat Sandía no completó el proceso de verificación de
Google".

This skill = add the Google account of a new company/hotel (the one that will
own its Google Sheet) to that list.

## Fixed facts

| Thing | Value |
|---|---|
| Google Cloud project | `chat-sandia` (project number `914913293424`) |
| OAuth client ID | `914913293424-n0t6fs2lc3g17lo693qdjq2uag16b1f4.apps.googleusercontent.com` |
| Test-users page | `https://console.cloud.google.com/auth/audience?project=chat-sandia` |
| OAuth client page | `https://console.cloud.google.com/auth/clients/914913293424-n0t6fs2lc3g17lo693qdjq2uag16b1f4.apps.googleusercontent.com?project=chat-sandia` |
| Redirect URIs the app sends | `https://chatsandia.com/api/google-sheets/oauth/callback` · `https://chatsandia.com/api/google-calendar/oauth/callback` (built from `NEXT_PUBLIC_SITE_URL`) |
| User cap | 100 for the lifetime of the project, cannot be reset. Removed testers still count. Check the counter before adding in bulk. |

## Steps (browser automation, Claude in Chrome)

1. **Confirm what you're adding.** You need the exact Gmail/Google-Workspace
   address. One address per run unless the user lists several.

2. Open `https://console.cloud.google.com/auth/audience?project=chat-sandia`.
   The signed-in Google account must be an owner/editor of the `chat-sandia`
   project (the platform admin's Google account). If it prompts for a
   password, **stop and ask the user to sign in** — never type a password.

3. Check **Publishing status**:
   - If it says **Testing** → go to step 4.
   - If it says **In production** → there is NO test-users list in that mode.
     Adding a tester REQUIRES switching to Testing, which affects the whole
     shared app (Sheets **and** Calendar): after the switch, any account not
     on the list can't authorize or re-authorize. **Surface this to the user
     and get an explicit yes before switching.** To switch: click
     **"Back to testing"** → **Confirm** in the dialog.

4. Scroll to **Test users** → click **"+ Add users"**.

5. Click the text field, type the email. **Do NOT rely on the Enter key** —
   the `key: Return` action is blocked by the automation classifier, and
   browser autofill may hijack the field with the signed-in account's own
   address. Instead:
   - Type the address.
   - Click **Save** ONCE — this converts the raw text into a chip (watch the
     "N / <cap>" counter tick to 1, and read the chip text).
   - **Verify the chip shows the address you intended** (not an autofilled
     one). If wrong, click the chip's ✕ and retype.
   - Click **Save** AGAIN — this actually submits and closes the panel.

6. **Reload the page** (`navigate` to the same URL). The list does not refresh
   reliably in place. Scroll to Test users and confirm the new address is
   listed.

7. Report back the full current list of test users.

## Removing a tester

Only if the user explicitly asks, and only the address they name. Trash icon
next to the row → **Confirm**. Note in your report: a removed tester still
counts against the 100 cap, and can't authorize again until re-added or the
app goes to production. **Never remove an address you didn't add this run
without the user confirming** — pre-existing testers belong to the user.

## Related / bigger picture

- Full manual (redirect URIs, the customer-facing connect flow, the "unverified
  app" click-through, the path to Google verification): `docs/google-oauth-chatsandia.md`.
- Full OAuth-client setup from scratch: the global `google-cloud-oauth-setup` skill.
- To make the app open to ANY Google account with no warning and no 100-cap:
  Audience page → **"Publish app"**, then complete Branding + submit for
  verification in the Verification centre.
