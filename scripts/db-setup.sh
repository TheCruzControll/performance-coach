#!/usr/bin/env bash
# Create the local Postgres role and databases used for development and tests. Idempotent.
#
#   pnpm db:setup
#
# Admin connection, in order of preference:
#   1. PGADMIN_URL            e.g. postgres://postgres:postgres@localhost:5432/postgres (CI)
#   2. PGHOST/PGUSER/...      standard libpq environment variables
#   3. the local `postgres` OS user via peer auth (runuser as root, else sudo)
#
# Override names with DB_USER, DB_PASSWORD, DB_NAMES ("coach_dev coach_test coach_e2e coach_explain
# coach_backup_src_test coach_backup_dst_test"; the last two are the backup tests' scratch pair).
set -euo pipefail

DB_USER="${DB_USER:-coach}"
DB_PASSWORD="${DB_PASSWORD:-coach}"
read -r -a DB_NAMES <<<"${DB_NAMES:-coach_dev coach_test coach_e2e coach_explain coach_backup_src_test coach_backup_dst_test}"

psql_admin() {
  local args=(-v ON_ERROR_STOP=1 -X -q -v "db_user=${DB_USER}" -v "db_password=${DB_PASSWORD}" "$@")
  if [[ -n "${PGADMIN_URL:-}" ]]; then
    psql "${PGADMIN_URL}" "${args[@]}"
  elif [[ -n "${PGHOST:-}" ]]; then
    psql -d "${PGDATABASE:-postgres}" "${args[@]}"
  elif [[ ${EUID} -eq 0 ]] && id postgres >/dev/null 2>&1; then
    (cd / && runuser -u postgres -- psql "${args[@]}")
  elif command -v sudo >/dev/null 2>&1 && id postgres >/dev/null 2>&1; then
    (cd / && sudo -u postgres psql "${args[@]}")
  else
    psql -d postgres "${args[@]}"
  fi
}

if ! command -v psql >/dev/null 2>&1; then
  echo "db-setup: psql not found. Install PostgreSQL 16 client tools first." >&2
  exit 1
fi

echo "db-setup: ensuring role '${DB_USER}'"
psql_admin <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'db_user', :'db_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'db_user') \gexec
ALTER ROLE :"db_user" WITH LOGIN PASSWORD :'db_password';
SQL

for db in "${DB_NAMES[@]}"; do
  echo "db-setup: ensuring database '${db}'"
  psql_admin -v "db_name=${db}" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'db_name', :'db_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'db_name', :'db_user') \gexec
SQL
done

echo "db-setup: done. Next: pnpm db:migrate && pnpm db:reset:test"
