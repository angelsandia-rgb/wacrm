-- ============================================================
-- 159 — Several rooms in one hotel request.
--
-- "2 Suite Premium para 2 parejas" was stored as ONE Premium for 4
-- people: unpriceable (the Premium tops out at 2) and misleading for the
-- team (test run 2026-09-24, B43). `rooms` is how many identical rooms
-- the request covers; `guests` stays the TOTAL headcount. NULL = 1 room
-- (every existing row). Different room types in one chat are separate
-- requests (the AI's `nueva=1`), not one row.
-- ============================================================

ALTER TABLE reservation_requests
  ADD COLUMN IF NOT EXISTS rooms SMALLINT
    CHECK (rooms IS NULL OR (rooms BETWEEN 1 AND 20));

COMMENT ON COLUMN reservation_requests.rooms IS
  'Identical rooms in this request (habitaciones/paquetes). NULL = 1. guests is the total headcount.';
