# 0011 — Email sign-in link: one-time links to the owner's address, off until configured

- **Status:** Accepted (M2X). Built across M2X's email slices. Production keeps it off until the
  owner follows docs/deployment.md's "Email sign-in link" steps, which land with the email
  section of docs/security.md.
- **Context:** The owner asked for a second way in, next to passkeys (PRD §13, 2026-11-06):
  "Email me a sign-in link". The gap is a desktop browser that holds no passkey, such as a laptop
  outside the owner's iCloud Keychain, where today the only way in is a recovery code, which is
  meant for losing every passkey. Passkeys stay primary (ADR 0006). The owner has already decided
  that mail goes through Resend's HTTP API on its free tier, that the link only ever goes to the
  owner's address (configuration, never the request), and that a link gives a full session while
  the actions behind step-up still need a passkey.

## Decision

- **Recipient.** A one-time link goes to `OWNER_EMAIL` only. The address comes from
  configuration, never from the request: the request carries no address at all. A mailer is
  created with its recipient and `send()` takes none, so no caller can address mail elsewhere.
- **Token.** 32 bytes from the platform CSPRNG (`generateToken`: 256 bits, base64url), carried in
  the URL fragment of `/?link` (`<origin>/?link#t=<token>`) and stored only as its SHA-256. The
  fragment never reaches a server, a log or a `Referer`. The URL is built from the relying
  party's origin (production: exactly `https://coach.nikocruz.com`), never from the `Host` header.
- **Lifetime.** Valid for 15 minutes and single use. Redeeming is one conditional
  `UPDATE … RETURNING` inside the transaction that rotates the presented session and issues the
  new one, so concurrent uses cannot both succeed. A newer link revokes every older live one
  (under the owner row lock). "Sign out everywhere else" revokes pending links and
  `pnpm auth:reset-owner` deletes them. Nothing is sent or redeemed while first-run setup is open.
- **One tap.** The link opens the sign-in screen in finish mode. The page removes the token from
  the address bar and posts it only when the owner taps Sign in; there is no GET handler.
  Redirects from `/?link` carry an empty fragment, because a `Location` without one inherits the
  request's (RFC 9110 §10.2.2): an owner session goes to `<next>#`, a recovery session to
  `/recover/passkey#`. A recovery session never redeems a link; it goes on to add a passkey.
- **Session.** A full owner session (method `email_link`), with a passkey session's lifetimes and
  no step-up freshness (`reauthenticated_at` is null). `requireRecentAuthentication` therefore
  still asks for a passkey before adding or removing passkeys, new recovery codes and signing
  devices out; `reauth.ts` does not change. Security labels the session "with email link".
- **The same answer.** The request endpoint reads no body and answers `202 {ok: true}` with
  `no-store` before doing any work. The limits, the owner and setup check, issuing the link,
  sending it and the audit run after the response (`waitUntil`). Status, body, headers and timing
  are the same whether a link was sent, a limit was hit, no owner exists or the provider failed.
- **Limits.** Per client: `email.request` 5 per 15 minutes and `email.verify` 10 per 15 minutes.
  Across all clients: `email.hourly` 10 per hour and `email.daily` 20 per day, at most about 620
  mails a month, inside Resend's free tier (100 a day, 3,000 a month).
- **Provider.** Resend's HTTP API over `fetch` (no SDK, no new dependency): plain text only, the
  link id as `Idempotency-Key`, a 10 s timeout and one attempt. Errors carry the status and
  Resend's error name, never the key or the text (the text holds the token). A recording test
  provider replaces Resend whenever test routes are enabled and allowed, even with a key present,
  so a test server never sends real mail. The test-route rules make it impossible on Vercel and
  in a Vercel build.
- **Off without configuration.** `OWNER_EMAIL`, `RESEND_API_KEY` and `EMAIL_FROM` are optional and
  never stop the server. `emailLinkConfig()` (`src/lib/server/auth/email-link-config.ts`) turns
  the feature off when one is missing or invalid, and the startup log names it, never its value.
  When off, the option is hidden and both endpoints answer 404. Previews are always off. The
  default sender, `DEFAULT_EMAIL_FROM`, is Resend's onboarding address until nikocruz.com is
  verified in Resend.
- **Production.** Off until the owner follows docs/deployment.md's switch-on steps, which land
  with the security reference.

## Threat model

| Threat                              | What limits it                                                                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A compromised mailbox               | Its holder can sign in, but cannot add a passkey, mint recovery codes, remove a passkey or sign the owner out without one of the owner's passkeys. The sign-in is audited and pinned on Security, where a passkey device can end that session.                            |
| Forwarding, a pasted link           | Single use, 15 minutes, and only the newest link works.                                                                                                                                                                                                                   |
| Prefetching scanners, link previews | The token is in the fragment, which is never fetched; finishing needs a tap (a POST). A scanner gets the sign-in page without the token.                                                                                                                                  |
| Replay                              | A link is consumed atomically with the session it creates; a used, revoked or expired link is refused.                                                                                                                                                                    |
| Enumeration and timing              | The request takes no address and answers 202 before any work, so nothing about the owner, the limits or the mail can be learnt from it.                                                                                                                                   |
| `Host`-header injection             | The link is built from the relying party's origin, never from the request.                                                                                                                                                                                                |
| Provider or key compromise          | The key is server-only and Production-only (Sensitive in Vercel). A stolen key sends mail as the sender but signs no one in; rotating it is a variable change. Resend sees each link, so a compromised Resend account equals a compromised mailbox, with the same limits. |
| Inbox and quota flooding            | Per-client and global limits. A flood can use up the daily cap and switch email sign-in off until the next day; passkeys are unaffected. Refused requests write only the first-refusal audit row.                                                                         |

## Consequences

- **The mailbox joins the trust base.** Whoever holds it can sign in. The owner's mail account
  needs the protection a password manager has (its own passkey or second factor).
- **ASVS 4.0.3**, recorded in docs/security.md with the email section:
  - **2.7.1 Met:** passkeys are offered first; the link appears only when configured, as a
    secondary option.
  - **Deviations**, each with the compensating controls above (single use, 15 minutes,
    newest-only, the step-up wall, the limits, the audit log, visibility on Security):
    - 2.2.2: email is a weaker authenticator, used here to sign in rather than only to confirm.
    - 2.7.2: links expire after 15 minutes, not 10 (the owner's choice).
    - 2.7.4: email is not a secure independent channel. NIST SP 800-63B §5.1.3.1 does not accept
      it as an out-of-band authenticator.
  - **2.7.3 Partial:** a link works once, but is not bound to the browser that asked for it.
  - 2.7.5 and 2.7.6 are met: only the SHA-256 is kept, and the token has 256 bits from the CSPRNG.
- **The installed iPhone app.** The link opens in Safari or the mail app's own browser, which
  share no cookies with the installed app, so it signs in that browser. The option stays visible
  in the app, with one line saying so.
- **Resend's onboarding sender** delivers only to the address that owns the Resend account. It
  serves while that is `OWNER_EMAIL`; verifying nikocruz.com and setting `EMAIL_FROM` lifts it.
- **No personal address in the repository.** The owner's address lives only in Vercel; examples
  and fixtures use `example.test`, and `scripts/no-personal-address.test.ts` fails on an address
  at a personal mail provider in any tracked file.

## Alternatives considered

| Option                                      | Why not                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed codes                                 | A short code has about 20 bits and leans on attempt limits; it is easier to phish by relay ("read me the code"), and typing it is slower than one tap.                                                                                                                                                                                                                          |
| A link that signs in on GET                 | Mail scanners and link previews open links: they would use or burn it.                                                                                                                                                                                                                                                                                                          |
| Binding the link to the requesting browser  | Fails the owner's own flows: a desktop mail client opens the default browser, Gmail on iPhone opens its in-app browser, and a link asked for on the laptop is often opened on the phone. A mailbox holder can request a link bound to their own browser, so binding stops only leaks of a link the owner asked for, which single use, 15 minutes and newest-only already limit. |
| An address in the request                   | Would let anyone send mail anywhere through the app, or probe which address is the owner's.                                                                                                                                                                                                                                                                                     |
| The Resend SDK                              | A dependency for one POST; `fetch` keeps the surface small and the errors free of the key and the text.                                                                                                                                                                                                                                                                         |
| Neon Auth or Better Auth magic links        | ADR 0006's reasoning: another identity service for one user, coupled to the database vendor, and its sessions would not be the app's (step-up, audit, Security).                                                                                                                                                                                                                |
| Reversible token storage (encrypted, plain) | A database read or a backup would yield a usable link. A 256-bit random token needs no salt or slow hash.                                                                                                                                                                                                                                                                       |

## Defaults the owner may change

Each is one value or one rule, and a change after merge updates this record in the same PR:

- links unbound to the requesting browser (binding is one cookie and one column);
- 15 minutes, not ASVS's 10;
- a link session lives as long as a passkey session (30 days idle, 90 days absolute);
- a new request voids earlier unused links, so a stranger can void one the owner has not opened;
- the limits above, and that a flood can switch email sign-in off for the rest of the day;
- a browser holding a recovery session ignores a link rather than upgrading the session;
- the option stays visible in the installed iPhone app, with one line explaining it.
