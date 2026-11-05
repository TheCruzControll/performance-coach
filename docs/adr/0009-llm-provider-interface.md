# 0009 — LLM behind a provider interface with a deterministic mock

- **Status:** Accepted (design; implemented in M5)
- **Context:** The coach needs structured tool calling over real training data; tests must be
  deterministic; no API key exists in development/CI; credentials must never reach the browser.

## Decision

All model access goes through an `LlmProvider` interface in `src/lib/server/agent/provider/`.
`LLM_PROVIDER=mock` (default) uses a deterministic, scripted provider for tests and keyless
development; `anthropic` uses the server-side API key (`ANTHROPIC_API_KEY`, validated at startup
only when selected). See docs/agent-architecture.md.

## Alternatives considered

- Calling a vendor SDK directly from services: couples business logic to one vendor and makes
  tests nondeterministic.
- Recorded HTTP fixtures (VCR-style) only: brittle when prompts change; still useful later for
  opt-in "real agent" integration tests.

## Consequences

- Agent behaviour is testable offline; switching or adding providers is local to one folder.
