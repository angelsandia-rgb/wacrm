-- ============================================================
-- 160 — Hotel vertical: child rates, room capacity, adults/children
-- on a request.
--
-- Angel, 2026-09-25: the Junior Suite Familiar must be quotable for 5
-- people, asking how many adults and children, with children priced at
-- the child rate of the night (corporativa Sun–Thu / recreativa Fri–Sat
-- / high season).
--
--   • product_rates.occupancy gains 'child' — the per-child price for a
--     night, by day of week and season exactly like the adult tiers. A
--     room with child rows prices children 6–12 separately; children
--     under 6 are free; 13+ are priced by a person.
--   • products.max_guests — the most people (adults + children) a room
--     takes. NULL = no explicit cap (adult tiers still stop at 4).
--   • reservation_requests.adults / children_ages — the headcount split
--     the AI captured. guests stays the TOTAL.
--
-- Widening a CHECK and adding nullable columns never rewrites rows.
-- Idempotent.
-- ============================================================

ALTER TABLE public.product_rates
  DROP CONSTRAINT IF EXISTS product_rates_occupancy_check;

ALTER TABLE public.product_rates
  ADD CONSTRAINT product_rates_occupancy_check
  CHECK (occupancy IN ('standard', 'couple', 'group', 'quad', 'child'));

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS max_guests SMALLINT
    CHECK (max_guests IS NULL OR (max_guests BETWEEN 1 AND 50));

COMMENT ON COLUMN public.products.max_guests IS
  'Hotel rooms: most people (adults + children) the room takes. NULL = no explicit cap.';

ALTER TABLE public.reservation_requests
  ADD COLUMN IF NOT EXISTS adults SMALLINT
    CHECK (adults IS NULL OR (adults BETWEEN 1 AND 100));

ALTER TABLE public.reservation_requests
  ADD COLUMN IF NOT EXISTS children_ages SMALLINT[]
    CHECK (children_ages IS NULL OR cardinality(children_ages) <= 20);

COMMENT ON COLUMN public.reservation_requests.adults IS
  'Adults in the request (habitaciones/paquetes). guests is the total headcount.';
COMMENT ON COLUMN public.reservation_requests.children_ages IS
  'Age of each child in the request, in years. Empty/NULL = no children captured.';
