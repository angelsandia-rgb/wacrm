# Push delivery and handoff information

AI handoff push messages lead with the contact name and the actual handoff reason/latest customer message, rather than internal routing boilerplate. Tapping opens the corresponding inbox conversation. The full internal note remains in the inbox. Payloads are bounded to 300 body characters.

All six current business notification types use shared Spanish titles and action text in push, foreground alerts and the notification history. Historical English rows are presented in Spanish without rewriting their stored content, timestamps or read status. Literal customer quotes, contact names, amounts and user-authored task names retain their original wording. Unknown notification types receive a Spanish fallback rather than exposing arbitrary internal English text. The history uses Spanish relative dates and wraps titles/bodies instead of truncating them to one line. Existing navigation is preserved.

Device configuration reads runtime server configuration, so missing build-time public keys no longer hide a correctly configured deployment. The settings card exposes unsupported, missing server configuration, blocked permission and registration failures. It reports enabled only after saving the local subscription to the server. Service-worker readiness is bounded, and permission is requested through the user's explicit settings action.

The server fanout route returns 503 when VAPID configuration is missing. A successful test means a push provider accepted at least one delivery, not that a person saw it. Test notification text and UI reflect this distinction.

## End-to-end verification

1. On the intended device, sign into the hotel account and open Settings > profile > Notificaciones push.
2. Enable notifications and accept the browser permission. Resolve any unsupported/blocked/error message shown. A service-worker subscription must be registered in `push_subscriptions` for that user.
3. Press Enviar prueba and confirm the OS actually displays it, including with the app in the background. Tap to verify navigation.
4. A new genuine AI handoff must create `ai_handoff` notification rows. The database `on_notification_push_fanout` trigger (migration 095) must invoke the production fanout route with its configured secret. Verify an actual alert appears and opens the right chat. Do not replay old customer cases or send customer messages merely to test.
5. If rows exist but push does not arrive, check the trigger/pg_net response, URL and secret, runtime VAPID keys, device subscription and OS notification permissions. No device subscription means push cannot reach that device; an unread notification row does not prove a push was displayed.

No migration, permission grant or fabricated device subscription is part of this patch. The existing DB trigger is the delivery integration point; device receipt and trigger invocation require a live end-to-end check.
