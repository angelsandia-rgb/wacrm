-- Defence in depth: RLS on a reservation does not scope its foreign keys.
-- Also covers authenticated clients writing directly through PostgREST.
BEGIN;

CREATE OR REPLACE FUNCTION public.guard_reservation_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (NEW.check_in IS NOT NULL AND NEW.check_out IS NOT NULL AND
      (NEW.check_out <= NEW.check_in OR NEW.check_out - NEW.check_in > 366))
     OR NEW.guests < 1 OR NEW.duration_minutes < 1 OR NEW.estimated_price < 0 THEN
    RAISE EXCEPTION 'Invalid reservation fields' USING ERRCODE = '23514';
  END IF;
  IF (NEW.contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.contacts WHERE id = NEW.contact_id AND account_id = NEW.account_id
  )) OR (NEW.conversation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.conversations WHERE id = NEW.conversation_id AND account_id = NEW.account_id
  )) OR (NEW.product_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.products WHERE id = NEW.product_id AND account_id = NEW.account_id
  )) OR (NEW.quote_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.quotes WHERE id = NEW.quote_id AND account_id = NEW.account_id
  )) THEN
    RAISE EXCEPTION 'Invalid reservation reference' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_reservation_tenant() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS guard_reservation_tenant ON public.reservation_requests;
CREATE TRIGGER guard_reservation_tenant BEFORE INSERT OR UPDATE
ON public.reservation_requests FOR EACH ROW EXECUTE FUNCTION public.guard_reservation_tenant();

-- Support account-scoped chronological lists and the hotel metrics OR predicate.
CREATE INDEX IF NOT EXISTS idx_reservations_account_created
  ON public.reservation_requests(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reservations_account_checkout
  ON public.reservation_requests(account_id, check_out);
CREATE INDEX IF NOT EXISTS idx_reservations_account_use_date
  ON public.reservation_requests(account_id, use_date);

CREATE OR REPLACE FUNCTION public.guard_product_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.products WHERE id = NEW.product_id AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'Invalid product rate reference' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.product_rates r
    WHERE r.account_id = NEW.account_id AND r.product_id = NEW.product_id
      AND r.day_of_week = NEW.day_of_week AND r.occupancy = NEW.occupancy
      AND r.id <> NEW.id
      AND ((r.date_from IS NULL AND NEW.date_from IS NULL) OR
           (r.date_from IS NOT NULL AND NEW.date_from IS NOT NULL AND
            r.date_from <= NEW.date_to AND NEW.date_from <= r.date_to))
  ) THEN
    RAISE EXCEPTION 'Overlapping product rates' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_product_rate() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS guard_product_rate ON public.product_rates;
CREATE TRIGGER guard_product_rate BEFORE INSERT OR UPDATE
ON public.product_rates FOR EACH ROW EXECUTE FUNCTION public.guard_product_rate();

COMMIT;
