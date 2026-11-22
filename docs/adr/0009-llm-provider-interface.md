# 0009 — LLM behind a provider interface with a deterministic mock

- **Status:** Accepted; implemented in M5
- **Context:** The coach needs structured tool calling over real training data; tests must be
  deterministic; no API key exists in development/CI; credentials must never reach the browser.

## Decision

All model access goes through an `LlmProvider` interface in `src/lib/server/agent/provider/`.
A deterministic, scripted MockProvider serves tests and keyless development; the Anthropic
provider uses the server-side API key (`ANTHROPIC_API_KEY`). See docs/agent-architecture.md.

Implemented in M5 (`provider/types.ts`, `mock.ts`, `anthropic.ts`). `provider/select.ts` chooses
from `LLM_PROVIDER` (`mock`, `anthropic` or `off`, with no default) and the key: unset means the
mock outside production and `anthropic` in production, and `off` is the owner's kill switch. A
missing key no longer fails startup; the coach reports itself unavailable (`no_key`) and the rest
of the app runs.

## Alternatives considered

- Calling a vendor SDK directly from services: couples business logic to one vendor and makes
  tests nondeterministic.
- Recorded HTTP fixtures (VCR-style) only: brittle when prompts change; still useful later for
  opt-in "real agent" integration tests.

## Consequences

- Agent behaviour is testable offline; switching or adding providers is local to one folder.
