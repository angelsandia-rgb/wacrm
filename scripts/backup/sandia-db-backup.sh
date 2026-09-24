#!/usr/bin/env bash
# ============================================================
# Daily logical backup of the production Supabase Postgres database.
#
# The project is on Supabase Free, which has NO automatic backups, so
# this is the only copy. Runs on the VPS (Contabo — a different provider
# from Supabase/AWS) from /etc/cron.d/sandia-db-backup.
#
# - Connection comes from libpq env vars (PGHOST, PGPORT, PGUSER,
#   PGDATABASE, PGPASSWORD) read from a root-only file — never from
#   argv, so the password never appears in `ps`.
# - Dumps the app's schemas in pg_dump custom format: public (all app
#   data), auth (users/identities), storage (object metadata only — the
#   files themselves live in Storage, not the DB) and cron (pg_cron jobs).
# - Verifies the archive (size + table of contents) before keeping it.
# - Reports a `db_backup` heartbeat (ok/error) through the same
#   record_heartbeat RPC the app's crons use, so a missed or failed
#   backup raises the existing staleness alert in /admin.
# - Keeps RETENTION_DAYS days of dumps.
#
# Setup / restore: docs/RUNBOOK.md §9.
# ============================================================
set -Eeuo pipefail
umask 077

CONF="${SANDIA_BACKUP_CONF:-/root/sandia-backup/backup.env}"
# shellcheck disable=SC1090
set -a; source "$CONF"; set +a
: "${PGHOST:?PGHOST missing in $CONF}"
: "${PGUSER:?PGUSER missing in $CONF}"
: "${PGPASSWORD:?PGPASSWORD missing in $CONF}"
PGPORT="${PGPORT:-5432}"
PGDATABASE="${PGDATABASE:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/sandia}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
PG_IMAGE="${PG_IMAGE:-postgres:17}"
# Fewer TOC entries than this means the dump is not the real database.
MIN_TOC_ENTRIES="${MIN_TOC_ENTRIES:-200}"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="sandia-$stamp.dump"
partial="$name.partial"

# Every pg tool runs in a throwaway container; credentials go in as env
# vars (docker -e NAME with no value copies it from this shell's env).
pg() {
  docker run --rm -i \
    -e PGHOST -e PGPORT -e PGUSER -e PGDATABASE -e PGPASSWORD \
    -v "$BACKUP_DIR:/backup" "$PG_IMAGE" "$@"
}
export PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD

heartbeat() { # <ok|error> <detail>
  local detail="${2//\'/}"
  pg psql -v ON_ERROR_STOP=1 -qAt -c \
    "select public.record_heartbeat('db_backup', '$1', '$detail', 86400)" \
    >/dev/null 2>&1 || echo "[backup] warning: heartbeat write failed" >&2
}

fail() {
  echo "[backup] $(date -u +%FT%TZ) FAILED: $1" >&2
  rm -f "$BACKUP_DIR/$partial"
  heartbeat error "$1"
  exit 1
}
trap 'fail "unexpected error at line $LINENO"' ERR

echo "[backup] $(date -u +%FT%TZ) starting $name"

pg pg_dump \
  --format=custom --compress=6 \
  --no-owner --no-privileges \
  --schema=public --schema=auth --schema=storage --schema=cron \
  --file="/backup/$partial" \
  || fail "pg_dump exited non-zero"

size_bytes="$(stat -c %s "$BACKUP_DIR/$partial")"
toc_entries="$(pg pg_restore --list "/backup/$partial" | grep -cv '^;' || true)"
if [ "$toc_entries" -lt "$MIN_TOC_ENTRIES" ]; then
  fail "archive has only $toc_entries TOC entries (expected >= $MIN_TOC_ENTRIES)"
fi

mv "$BACKUP_DIR/$partial" "$BACKUP_DIR/$name"
# The dump is written by the container, which ignores this shell's umask.
chmod 600 "$BACKUP_DIR/$name"
find "$BACKUP_DIR" -maxdepth 1 -name 'sandia-*.dump' -mtime +"$RETENTION_DAYS" -delete
kept="$(find "$BACKUP_DIR" -maxdepth 1 -name 'sandia-*.dump' | wc -l)"

detail="$name size=${size_bytes}B toc=$toc_entries kept=$kept"
echo "[backup] $(date -u +%FT%TZ) ok: $detail"
heartbeat ok "$detail"
