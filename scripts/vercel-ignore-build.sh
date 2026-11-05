#!/bin/sh
# Vercel "Ignored Build Step" (vercel.json → ignoreCommand): exit 0 skips the build, exit 1 builds.
#
# Production is deployed only by .github/workflows/deploy.yml: it is gated by the
# PRODUCTION_DEPLOY_ENABLED switch, migrates first, builds on the runner and uploads the prebuilt
# output, so Vercel never runs this step for it. Any production build Vercel starts by itself
# (a push to the production branch, the first build after importing the repository, a dashboard
# redeploy) is skipped here, so the app cannot reach coach.nikocruz.com behind the switch's back.
# Preview builds proceed (they stay behind Vercel's deployment protection).
if [ "${VERCEL_ENV:-}" = "production" ]; then
	echo "Skipping this production build: production deploys run only from GitHub Actions (deploy.yml, PRODUCTION_DEPLOY_ENABLED). See docs/deployment.md."
	exit 0
fi
echo "Building a ${VERCEL_ENV:-non-production} deployment."
exit 1
