#!/bin/sh
# Vercel build command (vercel.json → buildCommand).
#
# Preview and production builds apply pending migrations to their own Neon branch before the app
# is built, over the direct (non-pooled) DATABASE_URL_UNPOOLED that the Vercel project provides
# for that environment. A deployment only goes live after its build succeeds, so the schema is
# always migrated before the code that needs it serves traffic. Migrations are advisory-locked
# and idempotent (src/lib/server/db/migrate.ts), so concurrent builds are safe.
#
# Migration rule: the previous deployment keeps serving while this one builds, so every
# migration must work with the code that is currently live (expand → backfill → contract).
set -eu

case "${VERCEL_ENV:-}" in
	production | preview)
		if [ -z "${DATABASE_URL_UNPOOLED:-}" ]; then
			echo "vercel-build: DATABASE_URL_UNPOOLED is not set for the ${VERCEL_ENV} environment." >&2
			echo "vercel-build: add it in Vercel → Project → Settings → Environment Variables." >&2
			exit 1
		fi
		echo "vercel-build: migrating the ${VERCEL_ENV} database"
		pnpm db:migrate
		;;
	*)
		echo "vercel-build: VERCEL_ENV=${VERCEL_ENV:-unset}; not migrating"
		;;
esac

pnpm build
