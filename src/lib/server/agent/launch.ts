/**
 * The coach's launch switch. While it was false, production reported the coach unavailable
 * (not_launched) whatever LLM_PROVIDER and ANTHROPIC_API_KEY said, so merging coach code to main
 * (which deploys to production) never turned the real coach on early. Development, tests and
 * previews ignore it.
 *
 * The coach-launch slice flipped it to true, after the coach journeys (with the owner's
 * screenshot review), the degraded-state specs and the final performance pass; the owner gave a
 * written go-ahead in place of a live-suite run. Production now runs anthropic when LLM_PROVIDER
 * is unset and ANTHROPIC_API_KEY is set. To switch the coach off, set LLM_PROVIDER=off and
 * redeploy (no code change); leave this constant alone.
 */
export const COACH_LAUNCHED = true;
