# M9 open questions

From the M9 plan (`docs/handoff/plans/m9-plan.json`, 62 slices). Each has a default the slices follow unless the owner says otherwise.

1. M8 has no slice plan; its councils run through workflows/councils.js.
   - Default: v1.0.0 is tagged only after signoff-record merges and docs/reports carry M8's final council results.
   - Any M8 fix merged after the release-candidate runs restarts the evidence under the freeze rule.
   - An M8 fix that adds a route needs an example resolver and a body (surface-examples' and input-validation's tests say so). One that adds a table needs a backup classification, a text-columns entry and a restore-order snapshot update.

2. Fluid compute. Default: the backup route uses maxDuration 60, which is valid either way. Confirming Fluid for M5's 180 s coach turns is M5's check.

3. Hobby limits are not fully published. Default: build to at most daily, no retries and a few operations a day; the probe and the drill record the real counts.

4. Scheduled cron under Deployment Protection (all_except_custom_domains). Default: confirm the first scheduled run in the runtime logs.
   - If it is blocked, the tech lead runs `pnpm backup:run --blob` daily until the owner chooses.
   - Option 1: a scheduled GitHub workflow that calls the custom domain with a CRON_SECRET repository secret.
   - Option 2: a Deployment Protection change.

5. Public repository. Default: it stays public, by the owner's choice.
   - Evidence never carries personal data.
   - The pg_dump layer stays off unless the passphrase is strong.
   - secrets-scan audits every branch once.
   If the owner makes the repository private, the minute arithmetic in the decisions applies, and the browser smoke moves to daily.

6. GitHub's free controls (secret scanning with push protection, Dependabot alerts and security updates, CodeQL default setup). The session token cannot read their state (403). Default: the owner enables all three; F12 is closed when the owner confirms.

7. HTTPS in PR CI. Default: every PR runs the local-deployed smoke with E2E_TLS=1, and the release candidate runs all legs with E2E_TLS=1. The owner may make TLS the default for every PR leg once the release candidate has proven it stable.

8. WebAuthn behind the local TLS proxy. Default: Chromium trusts the throwaway certificate's SPKI, so real ceremonies run. If the pinned Chromium still refuses, TLS mode signs in with a minted session on Chromium too, and real HTTPS WebAuthn is proven by preview-e2e-run.

9. E2E and Lighthouse ceilings: 15 minutes per leg or shard. Default: add shards (free on a public repository) rather than trim WebKit or state coverage.

10. Cron time: '41 10 * * *' UTC. The owner may prefer an hour after evening workouts have synced.

11. Key placement. Default: BACKUP_ENCRYPTION_KEY and BLOB_READ_WRITE_TOKEN share the production environment, a recorded risk. A later alternative is X25519 key wrapping.

12. Key custody and rotation. Default: the key is kept in Vercel (Sensitive) and in the owner's password manager. Every drill decrypts with the password-manager copy. The key is rotated yearly or on suspicion, and old keys are kept for 13 months.

13. Backup contents. Default: auth tables and telemetry are included; only sessions, challenges, rate-limit counters, single-use links and backup_runs are excluded.

14. The --force scratch rule. Default: scratch_, restore_ or drill_ prefixes, or a _test suffix, never neondb or postgres.

15. Backup status on Profile. Default: a streamed 'Backups' row with a Skeleton while pending, a 36 h warning and a neutral 'unavailable', at most 0.2 KB. The alternative is no UI.

16. What 'production-like' means for criterion 1. Default:
   - (a) the full suite over HTTPS through the vercel.json-applying proxy, on the production build, Postgres 18 and the runtime role
   - (b) the golden path and the smoke on a preview
   - (c) the smoke on production after every deploy
   The owner confirms this meets the criterion.

17. Preview run. It needs the owner's go-ahead, a Preview-scoped token hash and the bypass secret. Default: ask once at preview-e2e-run; if declined, record the reason and rely on (a) and (c).

18. Runtime role switch. Default: Production's DATABASE_URL moves to coach_app_prod before sign-off, with the documented rollback and the db:grants step after any restore.

19. Auth-change notices need RESEND_API_KEY and OWNER_EMAIL. Default: they ship off, as a recorded residual risk.

20. Legacy recovery codes. Default: the owner replaces them at sign-off.

21. bfcache after sign-out. Default: 'private, no-store' on signed-in HTML, unless its measured cost on Back is noticeable.

22. Device data kept after sign-out. Default: the theme, M4's workout settings and the plate inventory.

23. Audit gate timing. Default: deps-audit lands after docs-m7, with minimumReleaseAge 1440.

24. Monthly retention. Default: the earliest backup of each month.

25. Release freeze. Default: after the third green run, any non-docs merge restarts the evidence. Three runs are needed for src/, drizzle/ or .github/ changes, and one for test- or script-only changes. The tech lead may ask the owner to accept a smaller re-run for an M8 copy-only fix.

26. Owner sign-off. Default: the Chrome-for-iOS real-device checklist, the §19 journeys done by hand on production, and a VoiceOver spot check. They are recorded in signoff-record with device, iOS version, browser, date and SHA. Screenshots stay private and are cited by date and SHA-256.
