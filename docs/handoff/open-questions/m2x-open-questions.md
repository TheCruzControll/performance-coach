1. Browser binding. A link works in any browser for its 15 minutes, once, and only the newest link is valid. Binding each link to the browser that asked (Plan B's design: one cookie and one column) would refuse forwarded links. It would also refuse the owner's own link in common cases:
- opened from a desktop mail client in another browser
- opened from Gmail's in-app browser
- opened on the phone after asking on the laptop

Keep links unbound?

2. Migration timing. The email link's database half waits for M3's last schema slot (db-explain, m3/33), as the brief says, so the feature ships near the end of M3's backend work. The alternative is to take the slot right after coaching-memory-db (m3/24), and have db-explain regenerate any index migration on top. Keep the brief's order?

3. Link-session lifetime. A link session lives as long as a passkey session (30 days idle, 90 days absolute). Should it be shorter, say 14 days absolute, because email is the weaker factor?

4. Superseding. A new request voids earlier unused links, and anyone can press the button. A stranger can therefore void a link the owner has not opened yet; the owner receives both emails and uses the newest. Is that acceptable?

5. Limits.
- Requests: 5 per 15 minutes per client, 10 per hour and 20 per day overall.
- Verifications: 10 per 15 minutes per client.
- A flood can use up the daily cap and switch email sign-in off until the next day; passkeys are unaffected.

Accept these values?

6. Expiry. The owner chose 15 minutes; ASVS 2.7.2 says 10. Keep 15 minutes, recorded as a deviation?

7. Recovery session and links. A link opened in a browser that holds a recovery session (after a recovery code) is ignored: the session goes on to add a passkey, and the link stays usable for its 15 minutes. Should it instead upgrade the session to a full one?

8. Installed iPhone app. The link opens in Safari or the mail app's own browser, which do not share cookies with the installed app, so it signs in that browser. The option stays visible in the installed app, with one line saying so. Should it be hidden there instead?

9. Keyboard order. The nav moves before <main> (at most 8 B on app routes), so on desktop the Tab order matches the rail on the left. On iPhone, VoiceOver then reads the tab bar before the content, though nothing moves visually. Accept this, or keep the old order and reach the rail after the content on desktop?

10. Rail or sidebar. From 1024 px the plan uses an 88 px rail with labels under the icons. Is a wider sidebar, with labels beside the icons, wanted from 1280 px? It is a CSS-only change.

11. Brand mark colour. The rail's mark draws its arc in --color-accent, the same volt as the favicon in both themes. On the white light-theme rail the volt arc is pale; --color-accent-text would read darker. Keep the volt?

12. Tablet. From 640 to 1023 px the bottom bar stays and the column widens from 34 to 40 rem; iPad landscape (1024 px and up) gets the rail. Confirm?

13. Security on desktop. Security keeps the readable column at 1440 px, as a settings screen (0 B). Two columns (passkeys and devices beside codes and activity) would cost 12 B of initial JS with a data-layout attribute, or 0 B as a CSS-only :has() declaration in Security's own stylesheet. Wanted?

14. Security's dates. Formatting Security's dates on the server as well would save 261 B more on the tightest route. The dates would then follow the profile's time zone instead of the device's zone as today, and the profile's zone stays UTC until onboarding or M3's Build records the device's. Keep them in the browser unless M2's or M3's route nodes need the bytes?

15. Train on desktop. The plan keeps M3's selected-day rendering and lays it out in two columns under a full-width week strip. A seven-day grid with every session visible would change M3's rendering and cost initial JS on /train. Is it wanted later, in M8?

16. Desktop Lighthouse in CI. It is measured locally and recorded in the docs. Asserting it in CI adds about 5 minutes per run. Is that wanted?

17. Security notices. With a mailer in place, security follow-up 3 becomes cheap: an email when a passkey is added, a recovery code is used or the owner is reset. Plan it as a PR after M2X?
## From #96 (desk rules), defaults taken
- Tablet: 640–1023 px keeps the bottom bar; 1024 px and up is desktop (BREAKPOINTS in scripts/layout-rules.test.ts, DESKTOP_MIN_WIDTH in e2e/desktop.ts).
- Security on desktop: one readable column, like the other settings screens.

## From #108 (email link config), defaults taken (ADR 0011)
Each default below is recorded in ADR 0011 under "Defaults the owner may change". The sender is the named constant `DEFAULT_EMAIL_FROM`.
- **Browser binding:** links are not bound to the browser that asked for them. Binding would take one cookie and one column.
- **Session lifetime:** a session started by a link lasts as long as a passkey session (30 days idle, 90 days absolute).
- **Superseding:** a new request voids earlier unused links.
- **Limits:**
  - `email.request` 5 per 15 minutes per client
  - `email.hourly` 10 per hour
  - `email.daily` 20 per day
  - `email.verify` 10 per 15 minutes per client
  - a flood can switch email sign-in off for the rest of the day
- **Expiry:** 15 minutes, recorded as an ASVS 2.7.2 deviation.
- **Recovery session:** a link opened in a browser that holds a recovery session is ignored, not upgraded.
- **Installed iPhone app:** the option stays visible, with one line explaining it.
- **Sender:** `DEFAULT_EMAIL_FROM` = `Performance Coach <onboarding@resend.dev>` until nikocruz.com is verified in Resend. Resend's onboarding sender delivers only to the address that owns the Resend account.
- **Strict sender format:** a quoted display name (`"Coach" <x@y>`) or a bare `<x@y>` counts as an invalid `EMAIL_FROM`. That switches the link off, and the startup log names it.

## From #113 (desk shell), defaults taken
- **Keyboard order:** the nav comes before `<main>` (+2 B of initial JS on app routes). On desktop, Tab goes skip link → rail → content; on iPhone, VoiceOver reads the tab bar first. To undo it, move `<AppNav>` back after `</main>` in AppShell.
- **Rail or sidebar:** an 88 px rail with labels under the icons (`--rail-width` in tokens.css). A labelled sidebar from 1280 px would be a CSS-only follow-up.
- **Brand mark colour:** volt `--color-accent` in both themes, matching the favicon. `--color-accent-text` is the darker alternative for the light rail; layout.css names it.
- **Tablet (640–1023 px):** the bottom bar stays and the column widens from 34 to 40 rem. The rail starts at 1024 px.
- **Security on desktop:** it keeps the readable column rather than going wide.
