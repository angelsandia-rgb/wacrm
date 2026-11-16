#!/usr/bin/env bash
# Concurrency check for migration 183 (purchase identity) against a REAL
# Postgres, because a mocked client cannot show locking or unique-index races.
#
#   docker run -d --rm --name cc-e1-pg -e POSTGRES_PASSWORD=test postgres:16-alpine
#   bash scripts/test-shopify-purchase-identity.sh        # needs that container
#
# It creates a throwaway database with stand-ins for the tables the Shopify
# migrations reference, applies 179–183 and exercises submit_shopify_order_request.
# Exits non-zero on the first failed expectation. Touches no real data.
set -euo pipefail
cd "$(dirname "$0")/.."
PG="docker exec -i ${PG_CONTAINER:-cc-e1-pg} psql -U postgres"
q() { $PG -d e1t -qtA -v ON_ERROR_STOP=1 -c "$1"; }
fail() { echo "FAIL: $1"; exit 1; }
expect() { [ "$2" = "$3" ] && echo "ok   $1" || fail "$1 — esperado '$3', obtenido '$2'"; }

$PG -q -c "DROP DATABASE IF EXISTS e1t" -c "CREATE DATABASE e1t" >/dev/null
$PG -d e1t -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE TABLE accounts(id UUID PRIMARY KEY);
CREATE TABLE contacts(id UUID PRIMARY KEY, account_id UUID);
CREATE TABLE conversations(id UUID PRIMARY KEY, account_id UUID, contact_id UUID, assigned_agent_id UUID,
  ai_autoreply_disabled BOOLEAN, ai_handoff_summary TEXT, ai_handoff_at TIMESTAMPTZ, ai_handoff_transient BOOLEAN);
CREATE TABLE deals(id UUID PRIMARY KEY, account_id UUID, contact_id UUID, title TEXT, status TEXT, stage_id UUID, pipeline_id UUID, shopify_order_id TEXT);
CREATE TABLE pipeline_stages(id UUID PRIMARY KEY, pipeline_id UUID, name TEXT, position INT);
CREATE TABLE profiles(user_id UUID, account_id UUID, account_role TEXT);
CREATE TABLE messages(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID, sender_type TEXT, content_type TEXT, content_text TEXT, status TEXT);
CREATE TABLE notifications(id UUID DEFAULT gen_random_uuid(), account_id UUID, user_id UUID, type TEXT, conversation_id UUID, title TEXT, body TEXT);
CREATE TABLE shopify_config(account_id UUID);
CREATE FUNCTION is_account_member(a UUID, r TEXT) RETURNS BOOLEAN LANGUAGE sql AS 'select true';
INSERT INTO accounts VALUES ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2');
INSERT INTO contacts VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1');
INSERT INTO conversations(id, account_id, contact_id) VALUES
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c2');
SQL
for m in 179_shopify_notification_jobs 180_shopify_order_requests 181_shopify_order_request_outcome 182_shopify_order_request_expired 183_shopify_purchase_identity 183_shopify_purchase_identity; do
  $PG -d e1t -q -v ON_ERROR_STOP=1 < "supabase/migrations/$m.sql" >/dev/null 2>&1 || fail "migración $m"
done
echo "ok   migraciones 179–183 aplicadas (183 dos veces: idempotente)"

A="'00000000-0000-0000-0000-0000000000a1'"; C="'00000000-0000-0000-0000-0000000000c1'"; D="'00000000-0000-0000-0000-0000000000d1'"
# submit <key|NULL> <purchase|NULL> [sleep seconds inside the transaction]
submit() {
  local key="NULL" purchase="NULL"
  [ "$1" != "NULL" ] && key="'$1'"; [ "$2" != "NULL" ] && purchase="'$2'"
  $PG -d e1t -qtA 2>&1 <<SQL
BEGIN;
SELECT public.submit_shopify_order_request($A, $C, $D, '{"items":[]}'::jsonb, 100, 'GTQ', '{"total":100}'::jsonb, $key, $purchase, '{"conversationId":"d1","text":"ask","template":null}'::jsonb);
SELECT pg_sleep(${3:-0});
COMMIT;
SQL
}
rows() { q "SELECT count(*) FROM shopify_order_requests WHERE $1"; }

# 1. Double click / two workers: the same submit twice at the same time.
submit K1 NULL 2 >/tmp/e1-a.out & sleep 0.5; submit K1 NULL >/tmp/e1-b.out; wait
expect "doble envío simultáneo crea una sola solicitud" "$(rows "idempotency_key = 'K1'")" 1
expect "…y una sola pregunta en la cola" "$(q "SELECT count(*) FROM shopify_notification_jobs")" 1
grep -q "Concurrent submit" /tmp/e1-b.out || fail "el segundo envío simultáneo debía pedir reintento"
expect "el reintento devuelve la misma solicitud (created=false)" "$(submit K1 NULL | grep -o '"created": *[a-z]*' | grep -o '[a-z]*$')" false

# 2. Two intended purchases by the same contact coexist.
submit K2 NULL >/dev/null
expect "dos compras legítimas del mismo contacto conviven" "$(rows "status = 'pending'")" 2
expect "…con identidades distintas" "$(q "SELECT count(DISTINCT purchase_id) FROM shopify_order_requests")" 2

# 3. An explicit edit keeps the purchase and closes the replaced revision.
P1=$(q "SELECT purchase_id FROM shopify_order_requests WHERE idempotency_key = 'K1'")
submit K3 "$P1" >/dev/null
expect "la edición conserva la identidad y sube la versión" "$(q "SELECT string_agg(revision || ':' || status, ',' ORDER BY revision) FROM shopify_order_requests WHERE purchase_id = '$P1'")" "1:superseded,2:pending"
expect "la otra compra no se toca" "$(rows "idempotency_key = 'K2' AND status = 'pending'")" 1
expect "la pregunta de la versión nueva está en la cola" "$(q "SELECT count(*) FROM shopify_notification_jobs j JOIN shopify_order_requests r ON j.event_key = 'request:' || r.id || ':ask' WHERE r.idempotency_key = 'K3' AND j.payload->'request'->>'id' = r.id::text")" 1

# 4. Two tabs edit the same purchase at once: one wins, the other is refused.
submit K4 "$P1" 2 >/tmp/e1-a.out & sleep 0.5; submit K5 "$P1" >/tmp/e1-b.out; wait
expect "dos ediciones simultáneas dejan una sola versión viva" "$(rows "purchase_id = '$P1' AND status IN ('pending','processing')")" 1
grep -q "Purchase is not editable" /tmp/e1-b.out || fail "la segunda edición simultánea debía rechazarse"
expect "…y la rechazada no dejó fila ni pregunta" "$(rows "idempotency_key = 'K5'")" 0

# 5. Two workers take the same "sí": only one starts creating the order.
LIVE=$(q "SELECT id FROM shopify_order_requests WHERE purchase_id = '$P1' AND status = 'pending'")
take() { $PG -d e1t -qtA -c "BEGIN; UPDATE shopify_order_requests SET status = 'processing', decided_at = now() WHERE id = '$LIVE' AND status = 'pending' RETURNING 'taken'; SELECT pg_sleep(${1:-0}); COMMIT;" 2>&1 | grep -c taken || true; }
take 2 >/tmp/e1-a.out & sleep 0.5; take >/tmp/e1-b.out; wait
expect "dos workers con el mismo «sí»: solo uno toma la compra" "$(( $(cat /tmp/e1-a.out) + $(cat /tmp/e1-b.out) ))" 1

# 6. A purchase already in creation cannot be edited; an old revision cannot be accepted.
submit K6 "$P1" | grep -q "Purchase is not editable" || fail "una compra en creación no debe poder editarse"
echo "ok   una compra en creación no se puede editar"
expect "una versión sustituida no se puede aceptar" "$($PG -d e1t -qtA -c "UPDATE shopify_order_requests SET status = 'processing' WHERE purchase_id = '$P1' AND revision = 1 AND status = 'pending' RETURNING 1" | grep -c 1 || true)" 0

# 7. Another contact or account cannot edit someone else's purchase.
P2=$(q "SELECT purchase_id FROM shopify_order_requests WHERE idempotency_key = 'K2'")
OTHER=$($PG -d e1t -qtA 2>&1 -c "SELECT public.submit_shopify_order_request($A, '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000d2', '{}'::jsonb, 1, 'GTQ', '{}'::jsonb, 'K7', '$P2', '{}'::jsonb)" || true)
case "$OTHER" in *"Purchase is not editable"*) ;; *) fail "otro contacto no debe poder editar la compra";; esac
OTHER=$($PG -d e1t -qtA 2>&1 -c "SELECT public.submit_shopify_order_request('00000000-0000-0000-0000-0000000000a2', $C, $D, '{}'::jsonb, 1, 'GTQ', '{}'::jsonb, 'K8', NULL, '{}'::jsonb)" || true)
case "$OTHER" in *"Order conversation not found"*) ;; *) fail "otra cuenta no debe poder usar esta conversación";; esac
echo "ok   otro contacto u otra cuenta no pueden tocar la compra"

$PG -q -c "DROP DATABASE e1t" >/dev/null
echo "TODO OK"
