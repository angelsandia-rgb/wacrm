-- ============================================================
-- 114_account_restaurant_menu_url.sql — the restaurant's menu PDF
--
-- Hotel accounts often run a restaurant whose menu already lives as a
-- PDF online (their own file, not something generated from `products`).
-- This column holds that PDF's URL so it can be sent to a guest who
-- asks for "el menú del restaurante" — by the AI auto-reply
-- (SEND_RESTAURANT_MENU marker) or by an agent from the composer's
-- "+" menu.
--
-- Set from Products → "Entrega del catálogo" (catalog-delivery-settings,
-- shown only on the `hotel` vertical). Nullable — null / empty means the
-- feature is simply unavailable and both send paths surface a clear
-- "no menu configured" error. Same one-scalar-column convention as
-- `catalog_pdf_url` (068) and `quote_delivery_mode` (109). Idempotent.
-- ============================================================

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS restaurant_menu_url TEXT;

COMMENT ON COLUMN public.accounts.restaurant_menu_url IS
  'URL of the restaurant menu PDF (migration 114) — sent on request by the AI (send_restaurant_menu marker) or an agent. Null = feature unavailable.';
