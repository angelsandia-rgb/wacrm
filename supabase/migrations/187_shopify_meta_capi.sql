-- Meta Conversions API for orders taken over WhatsApp (chat-sandia tag):
-- the dataset (pixel) id and its CAPI access token, encrypted like the other
-- secrets in this row. Both NULL = nothing is sent.
ALTER TABLE public.shopify_config ADD COLUMN IF NOT EXISTS meta_dataset_id text;
ALTER TABLE public.shopify_config ADD COLUMN IF NOT EXISTS meta_capi_token text;
