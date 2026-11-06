## What & why

<!-- One paragraph: what changed and why. Link the milestone / PRD section (docs/milestones.md). -->

Milestone: M?

## Changes

-

## Decisions & tradeoffs

<!-- New or changed architecture decisions? Add/update an ADR in docs/adr/. -->

## Evidence

<!-- Paste real output. Never claim a check passed without running it. -->

- [ ] `pnpm lint` — 0 errors
- [ ] `pnpm check` — 0 errors
- [ ] `pnpm test:unit`
- [ ] `pnpm test:integration`
- [ ] `pnpm test:e2e` (iPhone viewport) — screenshots attached for UI changes
- [ ] `pnpm build && pnpm build:node && pnpm budgets`
- [ ] Lighthouse (`pnpm lighthouse`) for performance-relevant changes — numbers recorded in docs/performance.md
- [ ] CI run linked, including the **WebKit** e2e project and its screenshots (WebKit cannot run in every dev environment)
- [ ] UI changes: real-device checklist done on an iPhone (docs/testing.md), device/iOS version and screenshots attached

## Acceptance criteria

<!-- Copy the milestone's criteria from docs/milestones.md and tick what this PR satisfies. -->

## Checklist

- [ ] Conventional Commit messages
- [ ] Migrations are committed SQL, backward compatible with the running app (expand → contract); `pnpm db:drift` clean
- [ ] Deployment config unchanged (`vercel.json`, `scripts/vercel-build.sh`: every merge to `main` deploys production), or changed deliberately with the reason stated
- [ ] No secrets, `.env` files, build output or large binaries
- [ ] Docs updated (README / docs/*) where behaviour or setup changed
