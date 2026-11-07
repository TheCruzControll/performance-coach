# NNNN — App-level encrypted backups: a daily cron, a sealed line archive, a private Blob

- **Status:** Proposed (M9). Numbered at merge, like a migration slot, so M9's slices refer to it
  by its title, "the app-level encrypted backups ADR". docs-m9 completes it with the measured
  sizes, durations and the restore drill's record.
- **Context:** The owner's data must survive losing the database (PRD §9, §13; M9 criterion 2).
  Production is on Vercel Hobby and Neon's free plan, and M9 adds no paid service. Neon's free
  plan has no scheduled snapshots, only a 6-hour point-in-time window. The tooling that builds
  the app cannot set GitHub Actions secrets, and the repository is public, so a workflow's
  artifacts are downloadable by any signed-in GitHub user. pg_dump is not available on a Vercel
  function. Hobby runs a cron at most once a day, on production only, within its hour, with no
  retries.

## Decision

- **Path.** A Vercel cron (`41 10 * * *` UTC, one entry) calls `GET /api/cron/backup`, which
  only `Authorization: Bearer <CRON_SECRET>` opens (a new `cron` access class; 404 while the
  secret is unset or shorter than 32 characters). The endpoint exports, seals and uploads one
  file to a **private** Vercel Blob store, reads it back, then prunes. Failures go to
  `app_errors` with kind `cron`. A missed or doubled run is absorbed by retention.
- **Archive** (`src/lib/domain/backup/format.ts`, format version 1). Gzipped lines. A header,
  then per table, in restore order, a section line and its rows, then the sequences, then a
  trailer. A row line is `row_to_json(t)::text` exactly as Postgres wrote it, in primary-key
  order, under pinned settings (TimeZone UTC, DateStyle 'ISO, YMD', IntervalStyle postgres,
  extra_float_digits 1, bytea_output hex). JavaScript never parses a row: restore hands the
  lines back to Postgres through `json_populate_record`, so every type survives byte for byte.
  Control lines start with `#` and hold one JSON object whose `kind` names it; a row always
  starts with `{`. The header holds the format, version, createdAt, appVersion, the schema
  (`drizzle.__drizzle_migrations`' hashes, their count and the last hash, shown as the tag
  `<count>-<hash8>`), the settings, each table's columns and each excluded table with its
  reason. The trailer holds per-table row counts and SHA-256 digests (over the table's row lines,
  recomputable in SQL) and a SHA-256 over every byte before it. Sequence values are text, since a
  bigint does not fit a JSON number. Any change to a line bumps the version, and the reader keeps
  reading the old one.
- **Contents.** Every public table is exported except a named deny-list, each with its reason:
  sessions, WebAuthn challenges, rate-limit counters, single-use sign-in links and the backup
  run log. Auth tables and telemetry are included. A table without a primary key fails the
  export by name.
- **Consistency.** One `REPEATABLE READ READ ONLY` transaction under `pg_try_advisory_xact_lock`
  (safe through Neon's transaction pooler) reads the rows through a cursor, 500 at a time, with
  `statement_timeout` 60 s and `idle_in_transaction_session_timeout` 30 s. It lives only while
  rows are read.
- **Sealed before upload.** Gzip, then AES-256-GCM with `node:crypto` only: a 24-byte header
  (`PCBK`, a format byte, an algorithm byte, an 8-byte key id, a 12-byte random IV) that is also
  the AAD, the ciphertext, then the 16-byte tag. `BACKUP_ENCRYPTION_KEY` is exactly 32 bytes, an
  opaque value that never prints. The sealed bytes fill a bounded buffer (64 MB cap), the
  transaction commits, and only then does the upload start, so a slow store never holds a
  snapshot or a connection open. Opening a file checks the key id and verifies the tag before
  releasing any byte. Plaintext never reaches the store.
- **Names and retention** (`pathnames.ts`, `retention.ts`). Objects are
  `backups/YYYY/MM/DD/coach-YYYYMMDDTHHMMSSZ.pcbk` in UTC, so a name dates its backup without
  opening it, and anything else under the prefix is not a backup. Keep the newest backup of each
  of the last 30 UTC days and the earliest of each of the last 12 UTC months (about 42 objects).
  Never delete the file just written, a future-dated object or a name that does not parse.
  Delete only after a complete listing and a verified read-back.
- **Restore is an operator tool** (`pnpm backup:restore`, in `scripts/backup/`), never server
  code. Before the first write it verifies the key id, the tag, gunzip under a cap, every
  section, the trailer, and that the backup's migrations are a prefix of the target's journal.
  The target must be blank, or migrated and empty at the backup's tag. Then, in **one
  transaction**: the pinned settings; `DISABLE TRIGGER USER` on every exported table, so the
  database's own guard and audit triggers neither refuse nor rewrite restored rows; the rows in
  restore order with their identities (`OVERRIDING SYSTEM VALUE`); the late columns of a
  foreign-key cycle; `setval` for every sequence; `ENABLE TRIGGER USER`; the digests recomputed
  in SQL and compared with the trailer, rolling back on any difference; then a marker and
  `COMMIT`. A rerun of the same file answers already restored. The runtime grants are re-applied
  after it.

## Alternatives

- **Neon scheduled snapshots:** not on the free plan; the 6-hour point-in-time window stays as
  the third layer, for mistakes noticed the same morning.
- **pg_dump in GitHub Actions** (`backup.yml`, kept as an optional layer): it needs repository
  secrets the tooling cannot set, and on a public repository its artifacts are downloadable by
  any signed-in GitHub user. It stays off while the repository is public, unless
  `BACKUP_PASSPHRASE` carries at least 128 random bits.
- **pg_dump on a function:** Vercel functions have no pg_dump binary, and a dump's custom format
  needs pg_restore for every read.
- **Export through Drizzle or JavaScript objects:** parsing rows into JavaScript loses
  microseconds, numeric digits, bigints and bytea unless every type is mapped by hand; Postgres's
  own row text needs no mapping.
- **A paid backup service or object store:** ruled out by M9's no-paid-service rule.

## Consequences

- Backups need no migration: the export, envelope, store, cron and restore touch no schema.
- A new table must have a primary key, and a new cross-table cycle a nullable foreign-key column
  that restore fills late; the export fails by name otherwise.
- The key and the Blob token share Vercel's production environment, a recorded risk; the key is
  also kept in the owner's password manager, and every restore drill decrypts with that copy.
- A lost key makes every backup sealed with it unreadable. Rotation keeps old keys for 13 months.
- The cron's GET has a side effect, justified only by the bearer secret.
