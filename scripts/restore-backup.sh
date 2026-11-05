#!/usr/bin/env bash
# Restore an encrypted backup produced by .github/workflows/backup.yml.
#
#   BACKUP_PASSPHRASE=... scripts/restore-backup.sh <coach-*.dump.gpg> <target-database-url> [--yes]
#
# - Verifies the .sha256 file when present, decrypts with gpg (AES-256, symmetric) into a
#   private temp dir, validates the archive, then runs pg_restore in a single transaction
#   (--clean --if-exists: objects in the backup are dropped and recreated in the target).
# - Restore into a NEW Neon branch (or a scratch local database) first, verify, then promote.
#   Use a direct (non-pooled) connection string for the target.
# - Asks for confirmation unless --yes is passed. Never prints the passphrase or password.
set -euo pipefail

usage() {
  echo "usage: BACKUP_PASSPHRASE=... $0 <backup.dump.gpg> <target-database-url> [--yes]" >&2
  exit 2
}

[[ $# -ge 2 ]] || usage
backup="$1"
target="$2"
confirm="${3:-}"

for tool in gpg pg_restore; do
  command -v "$tool" >/dev/null 2>&1 || { echo "restore: '$tool' is required" >&2; exit 1; }
done
[[ -f "$backup" ]] || { echo "restore: no such file: $backup" >&2; exit 1; }

redacted=$(printf '%s' "$target" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#')

if [[ -f "$backup.sha256" ]]; then
  (cd "$(dirname "$backup")" && sha256sum --check --status "$(basename "$backup").sha256") \
    || { echo "restore: checksum mismatch for $backup" >&2; exit 1; }
  echo "restore: checksum OK"
fi

if [[ -z "${BACKUP_PASSPHRASE:-}" ]]; then
  read -rsp "Backup passphrase: " BACKUP_PASSPHRASE
  echo
fi

if [[ "$confirm" != "--yes" ]]; then
  echo "restore: this will DROP and recreate the backed-up objects in: $redacted"
  read -rp "Type 'restore' to continue: " answer
  [[ "$answer" == "restore" ]] || { echo "restore: aborted"; exit 1; }
fi

workdir=$(mktemp -d)
chmod 700 "$workdir"
trap 'rm -rf "$workdir"' EXIT
umask 077
printf '%s' "$BACKUP_PASSPHRASE" > "$workdir/passphrase"

gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$workdir/passphrase" \
  --decrypt --output "$workdir/backup.dump" "$backup"
rm -f "$workdir/passphrase"

entries=$(pg_restore --list "$workdir/backup.dump" | grep -cv '^;' || true)
echo "restore: archive OK ($entries entries); restoring into $redacted"

pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error \
  --dbname="$target" "$workdir/backup.dump"

echo "restore: done"
