#!/bin/sh
# Vercel "Ignored Build Step" (vercel.json → ignoreCommand): exit 0 skips the build, exit 1 builds.
#
# No production before auth (docs/deployment.md): until passkey sign-in ships (M2), every page is
# unauthenticated, so the app must not be served on coach.nikocruz.com. vercel.json already stops
# Vercel creating deployments for `main`; this step additionally skips any production build Vercel
# starts by itself (a dashboard redeploy, a production branch rename, the first build after
# linking). Preview builds proceed: they stay behind Vercel Authentication.
#
# The M2 pull request that ships auth removes both guards; from then on every merge to `main`
# deploys production through the Vercel Git integration (migrating first, see vercel-build.sh).
if [ "${VERCEL_ENV:-}" = "production" ]; then
	echo "Skipping this production build: production stays off until passkey auth ships (M2). See docs/deployment.md."
	exit 0
fi
echo "Building a ${VERCEL_ENV:-non-production} deployment."
exit 1
