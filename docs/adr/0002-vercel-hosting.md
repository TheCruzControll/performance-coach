# 0002 — Host on Vercel (Node runtime, Fluid compute) behind Cloudflare DNS

- **Status:** Accepted (M1)
- **Context:** Needs HTTPS on `coach.nikocruz.com`, global static asset delivery, low-latency
  SSR close to the database, preview deployments per PR, and no servers to patch.

## Decision

- Deploy with `@sveltejs/adapter-vercel` on the **Node.js 22 runtime** (Fluid compute: one
  instance serves concurrent requests, so a small `pg` pool is reused).
- DNS stays at **Cloudflare** as a **DNS-only CNAME** (`coach` → `cname.vercel-dns.com`), so Vercel
  issues the certificate and its CDN serves assets (no double proxy).
- The adapter is switchable: `ADAPTER=node` builds with `@sveltejs/adapter-node` so e2e tests,
  Lighthouse and CI run the **same production build** on a real Node server.
- Production deploys run only from GitHub Actions (`deploy.yml`) with the Vercel CLI after CI is
  green, applying database migrations first. Vercel's own Git deployments of `main` are disabled
  and any production build Vercel starts itself is skipped, both by the committed `vercel.json`
  (docs/deployment.md); preview deployments still build from Git.

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
