/**
 * The coach's launch switch. While it is false, production reports the coach unavailable
 * (not_launched) whatever LLM_PROVIDER and ANTHROPIC_API_KEY say, so merging coach code to main
 * (which deploys to production) never turns the real coach on early. Development, tests and
 * previews ignore it.
 *
 * Only the coach-launch slice flips it to true, after the coach journeys (with the owner's
 * screenshot review), the degraded-state specs, the final performance pass and a run of the live
 * suite. To switch the coach off after launch, set LLM_PROVIDER=off and redeploy instead.
 */
export const COACH_LAUNCHED = false;
