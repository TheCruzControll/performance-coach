# 0002 — Host on Vercel (Node runtime, Fluid compute) behind Cloudflare DNS

- **Status:** Accepted (M1)
- **Context:** Needs HTTPS on `coach.nikocruz.com`, global static asset delivery, low-latency
  SSR close to the database, preview deployments per PR, and no servers to patch.

## Decision

- Deploy with `@sveltejs/adapter-vercel` on the **Node.js 22 runtime** (Fluid compute: one
  instance serves concurrent requests, so a small `pg` pool is reused).
- DNS stays at **Cloudflare** as a **DNS-only CNAME** (`coach` → the project-specific `*.vercel-dns-017.com` target Vercel assigns), so Vercel
  issues the certificate and its CDN serves assets (no double proxy).
- The adapter is switchable: `ADAPTER=node` builds with `@sveltejs/adapter-node` so e2e tests,
  Lighthouse and CI run the **same production build** on a real Node server.
- Deploys run through the Vercel Git integration (every PR a preview, `main` production). The
  committed build command (`scripts/vercel-build.sh`) migrates the deployment's own Neon branch
  before building, so the schema is in place before the new code serves traffic, with no deploy
  token or CI secret to manage. Until auth ships (M2), the committed `vercel.json` disables Git
  deployments of `main` and skips any production build Vercel starts itself (docs/deployment.md).
  _Revised after M1 review: a GitHub Actions + Vercel CLI deploy was first planned; it needed a
  long-lived Vercel token in GitHub secrets for no extra safety, since Vercel only promotes a
  deployment whose build (including its migration) succeeded._

## Alternatives considered

| Option                       | Why not (for now)                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| Cloudflare Workers/Pages     | Edge runtime: TCP Postgres needs Hyperdrive; Node APIs (AsyncLocalStorage, pg) constrained. |
| Fly.io / Railway (container) | Always-on VM to manage and pay for; no built-in preview-per-PR CDN story.                   |
| Self-hosted VPS              | Patching, TLS, backups and uptime become our job — wrong tradeoff for one user.             |
| Vercel Edge runtime          | No TCP sockets for `pg`; we prefer the Node runtime + regional co-location with Neon.       |
| Cloudflare proxied (orange)  | Double CDN/TLS in front of Vercel complicates caching and certificate issuance.             |

## Consequences

- Choose the Vercel function region to match the Neon region (e.g. Neon `aws-us-east-1` →
  Vercel `iad1`) — see docs/deployment.md.
- Vercel compresses HTML at the edge; the local adapter-node server does not, so local
  Lighthouse numbers include uncompressed HTML (pessimistic).
- Vendor coupling is limited to the adapter and `attachDatabasePool`; switching hosts means
  swapping the adapter.
