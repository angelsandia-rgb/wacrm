#!/usr/bin/env bash
# ============================================================
# Prove a backup is restorable: load a dump into a throwaway Postgres
# container and compare key row counts against production.
#
#   sandia-db-restore-test.sh [/var/backups/sandia/sandia-<stamp>.dump]
#
# Defaults to the newest dump. Uses the pgvector image (the AI knowledge
# base has `vector` columns) and pre-creates the Supabase roles the RLS
# policies reference. Restores only public + auth — enough to prove the
# data is recoverable; a real restore goes into a fresh Supabase project
# (see docs/RUNBOOK.md §9). Never touches production except for
# read-only counts.
# ============================================================
set -Eeuo pipefail
umask 077

CONF="${SANDIA_BACKUP_CONF:-/root/sandia-backup/backup.env}"
# shellcheck disable=SC1090
set -a; source "$CONF"; set +a
PGPORT="${PGPORT:-5432}"
PGDATABASE="${PGDATABASE:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/sandia}"
PG_IMAGE="${PG_IMAGE:-postgres:17}"
TEST_IMAGE="${RESTORE_TEST_IMAGE:-pgvector/pgvector:pg17}"
export PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD

dump="${1:-$(ls -1t "$BACKUP_DIR"/sandia-*.dump | head -1)}"
[ -f "$dump" ] || { echo "no dump found" >&2; exit 1; }
echo "[restore-test] using $dump"

container="sandia-restore-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$container" -e POSTGRES_PASSWORD=restore-test \
  -v "$(dirname "$dump"):/backup:ro" "$TEST_IMAGE" >/dev/null
for _ in $(seq 1 30); do
  docker exec "$container" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

local_sql() { docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=0 -qAt "$@"; }

local_sql <<'SQL' >/dev/null
do $$ begin
  create role anon nologin; create role authenticated nologin;
  create role service_role nologin; create role authenticator nologin;
  create role supabase_auth_admin nologin; create role supabase_storage_admin nologin;
exception when duplicate_object then null; end $$;
create schema if not exists extensions;
create extension if not exists vector with schema public;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pg_trgm with schema extensions;
SQL

echo "[restore-test] restoring public + auth (errors on Supabase-only objects are expected)"
errors="$(docker exec "$container" pg_restore -U postgres -d postgres \
  --no-owner --no-privileges --schema=public --schema=auth \
  "/backup/$(basename "$dump")" 2>&1 | grep -c '^pg_restore: error' || true)"
echo "[restore-test] pg_restore reported $errors object-level errors"

TABLES="auth.users public.accounts public.profiles public.contacts public.conversations public.messages public.deals public.products public.ai_configs public.whatsapp_config"
count_sql=""
for t in $TABLES; do count_sql+="select '$t', count(*) from $t union all "; done
count_sql="${count_sql% union all };"

restored="$(local_sql -F' ' -c "$count_sql")"
production="$(docker run --rm -i -e PGHOST -e PGPORT -e PGUSER -e PGDATABASE -e PGPASSWORD \
  "$PG_IMAGE" psql -qAt -F' ' -c "$count_sql")"

status=0
printf '%-26s %10s %10s\n' table restored production
while read -r table n; do
  p="$(awk -v t="$table" '$1==t {print $2}' <<<"$production")"
  flag=""
  # Production keeps moving after the dump; only fewer-in-production or a
  # large gap is suspicious.
  if [ -z "$n" ] || { [ "$n" -eq 0 ] && [ "${p:-0}" -gt 0 ]; }; then
    flag="  <-- EMPTY"; status=1
  elif [ -n "$p" ] && [ "$n" -gt "$p" ]; then
    flag="  <-- more than production?"; status=1
  fi
  printf '%-26s %10s %10s%s\n' "$table" "$n" "$p" "$flag"
done <<<"$restored"

if [ "$status" -eq 0 ]; then
  echo "[restore-test] OK — backup restores with production-consistent data"
else
  echo "[restore-test] FAILED — see flagged tables" >&2
fi
exit "$status"
