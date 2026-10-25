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

# ---- Off-site copy (Cloudflare R2) --------------------------------------
# The dumps above live on this same VPS, so losing the server loses them.
# When R2_* is set in $CONF, push tonight's dump plus every Storage file
# (which pg_dump does not cover) to R2. A failure here reports the same
# db_backup error heartbeat, so it alerts like a failed dump.
# Everything is client-side encrypted (rclone crypt, R2_CRYPT_PASSWORD) —
# R2 only ever sees ciphertext. Without that password the R2 copy is
# unreadable, so it must also be kept outside this VPS (RUNBOOK §9).
if [ -n "${R2_ACCOUNT_ID:-}" ]; then
  : "${R2_CRYPT_PASSWORD:?R2_CRYPT_PASSWORD missing in $CONF}"
  R2_BUCKET="${R2_BUCKET:-sandia-backups}"
  R2_DB_RETENTION_DAYS="${R2_DB_RETENTION_DAYS:-30}"
  APP_CONTAINER_FILTER="${APP_CONTAINER_FILTER:-name=sandia_crm}"
  export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
    RCLONE_CONFIG_R2_ENDPOINT="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com" \
    RCLONE_CONFIG_R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID missing}" \
    RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY missing}" \
    RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true \
    RCLONE_CONFIG_R2_NO_HEAD=true  # rclone 1.60 HEADs ?versionId= after each PUT; R2 answers 501
  # File names stay readable (contents encrypted) so the bucket is browsable.
  export RCLONE_CONFIG_R2C_TYPE=crypt RCLONE_CONFIG_R2C_REMOTE="r2:$R2_BUCKET" \
    RCLONE_CONFIG_R2C_FILENAME_ENCRYPTION=off RCLONE_CONFIG_R2C_DIRECTORY_NAME_ENCRYPTION=false
  # Via stdin so the password never appears in `ps`.
  RCLONE_CONFIG_R2C_PASSWORD="$(printf '%s' "$R2_CRYPT_PASSWORD" | rclone obscure -)"
  export RCLONE_CONFIG_R2C_PASSWORD

  rclone copy "$BACKUP_DIR/$name" r2c:db/ \
    || fail "offsite: dump upload to R2 failed"
  rclone delete r2c:db/ --min-age "${R2_DB_RETENTION_DAYS}d" \
    || fail "offsite: R2 dump retention failed"

  # Supabase Storage over its S3 protocol, authenticated with the app's own
  # keys read from the running container (never copied to disk here, and
  # always current after a key rotation).
  app="$(docker ps -q -f "$APP_CONTAINER_FILTER" | head -1)"
  [ -n "$app" ] || fail "offsite: app container not found ($APP_CONTAINER_FILTER)"
  sb_env() { docker exec "$app" printenv "$1"; }
  sb_url="$(sb_env NEXT_PUBLIC_SUPABASE_URL)" || fail "offsite: SUPABASE_URL unreadable"
  sb_ref="${sb_url#https://}"; sb_ref="${sb_ref%%.*}"
  export RCLONE_CONFIG_SB_TYPE=s3 RCLONE_CONFIG_SB_PROVIDER=Other \
    RCLONE_CONFIG_SB_ENDPOINT="$sb_url/storage/v1/s3" RCLONE_CONFIG_SB_REGION=us-west-2 \
    RCLONE_CONFIG_SB_FORCE_PATH_STYLE=true RCLONE_CONFIG_SB_ACCESS_KEY_ID="$sb_ref"
  RCLONE_CONFIG_SB_SECRET_ACCESS_KEY="$(sb_env NEXT_PUBLIC_SUPABASE_ANON_KEY)" \
    || fail "offsite: anon key unreadable"
  RCLONE_CONFIG_SB_SESSION_TOKEN="$(sb_env SUPABASE_SERVICE_ROLE_KEY)" \
    || fail "offsite: service role key unreadable"
  export RCLONE_CONFIG_SB_SECRET_ACCESS_KEY RCLONE_CONFIG_SB_SESSION_TOKEN

  # ponytail: copy never deletes, so files removed from Storage stay in R2
  # forever (fine at ~60 MB; switch to sync --backup-dir if it grows).
  rclone copy sb: r2c:storage/ --fast-list \
    || fail "offsite: Storage copy to R2 failed"
  detail="$detail offsite=r2"
fi

echo "[backup] $(date -u +%FT%TZ) ok: $detail"
heartbeat ok "$detail"
