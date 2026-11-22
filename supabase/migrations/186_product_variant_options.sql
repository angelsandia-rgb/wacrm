-- Shopify products with sizes/colors (clothing, shoes): the catalog keeps one
-- row per product (shopify_variant_id = first variant) and lists every
-- variant here, so the AI can ask for the size and the order uses the exact
-- variant. Shape: [{ "id": gid, "title": "M / NEGRO", "price": 309, "available": true }].
-- NULL for single-variant products.
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS variant_options jsonb;
