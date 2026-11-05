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

## Acceptance criteria

<!-- Copy the milestone's criteria from docs/milestones.md and tick what this PR satisfies. -->

## Checklist

- [ ] Conventional Commit messages
- [ ] Migrations are committed SQL, backward compatible with the running app (expand → contract)
- [ ] No secrets, `.env` files, build output or large binaries
- [ ] Docs updated (README / docs/*) where behaviour or setup changed
