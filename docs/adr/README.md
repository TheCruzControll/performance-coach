# Architecture Decision Records

Short records of significant decisions: context, decision, alternatives, consequences.
Status values: Proposed · Accepted · Superseded.

| #                                        | Decision                                                      | Status   |
| ---------------------------------------- | ------------------------------------------------------------- | -------- |
| [0001](0001-single-sveltekit-app.md)     | One SvelteKit 3 app (Svelte 5, TypeScript strict, Vite, pnpm) | Accepted |
| [0002](0002-vercel-hosting.md)           | Vercel (Node runtime, Fluid compute) + Cloudflare DNS         | Accepted |
| [0003](0003-postgres-neon-drizzle.md)    | PostgreSQL on Neon, Drizzle ORM, node-postgres pool           | Accepted |
| [0004](0004-layered-modules.md)          | Layered modules with lint-enforced import boundaries          | Accepted |
| [0005](0005-hand-built-design-system.md) | Hand-built design system on CSS custom properties             | Accepted |
| [0006](0006-in-app-passkey-auth.md)      | In-app passkey (WebAuthn) authentication (SimpleWebAuthn)     | Accepted |
| [0007](0007-observability.md)            | Built-in observability: Server-Timing, JSON logs, RUM table   | Accepted |
| [0008](0008-testing-strategy.md)         | Testing pyramid: Playwright e2e, real-Postgres integration    | Accepted |
| [0009](0009-llm-provider-interface.md)   | LLM behind a provider interface with a deterministic mock     | Accepted |
| [0010](0010-program-versioning.md)       | Immutable program versions with copy-on-write membership      | Accepted |
