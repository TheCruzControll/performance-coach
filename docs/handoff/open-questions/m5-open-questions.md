1. Launch: production keeps the coach off (not_launched) until coach-launch merges. That happens after the journeys, your screenshot review, the degrade proof, the final perf pass and a live run. Confirm that order. Should launch wait for a live run by the tech lead, or is your written go-ahead enough?

2. Kill switch: LLM_PROVIDER=off (then a redeploy) turns the coach off in every environment, with no direct answers either. Is that the switch you want, or should 'off' still allow direct answers?

3. Daily cost cap and rate limit: the plan uses $5 a day and 30 turns per 10 minutes. Confirm, or name your own values.

4. Cancel on disconnect: backgrounding the iPhone mid-answer interrupts the turn, and the answer shows 'interrupted' with Retry. Is that acceptable, or should turns keep running for a short grace period?

5. Environment name: the brief says COACH_PROVIDER, but the code and docs use LLM_PROVIDER, and the plan keeps it with no alias. Unset means anthropic in production once launched, and the mock elsewhere. Confirm both.

6. After an explicit dislike, replacing its upcoming occurrences is a proposal you accept. Should it apply immediately instead?

7. create_training_program works only when no program is active. Do you want a 'replace my program' path?

8. Please confirm that M6 consumes accepted next_cycle proposals.

9. Vercel: COACH_MAX_DURATION_S is 180 s, which needs Fluid compute on the Hobby plan. Please confirm. The fallback is 60 s: 30 s turns, and 25 s for drafting tools with 15 s drafts.

10. Conversations can be archived (and found again under Archived) but not deleted. Should they be deletable?

11. Thread titles come from the first message. Do you want titles written by the model?

12. Coach keeps M2X's readable column; only the inbox uses the split layout. Do you want a split conversation layout on desktop? It would mean editing M2X's pinned shell specs with M2X's agreement.

13. M4 coordination: does the sync dispatcher expose a per-mutation function (otherwise it is exported in one hunk)? Is M4 happy for coach-exercise-sheet to add the exercise-id-only mode to ExerciseHistorySheet after workout-design?

14. If the live suite shows poor label compliance, chat turns switch to output_config.format. Who runs the live suite before coach-launch?
## From #101 (coach contract), defaults taken
- Kill switch (open question 2). Default: `disabled` (`LLM_PROVIDER=off`) refuses every turn, direct answers included, the same as `not_launched`. It is recorded in `COACH_UNAVAILABLE_REASONS` in `vocabulary.ts`, and provider selection implements it.
- Label compliance (open question 14). Default: chat turns use the tagged grammar. ADR 0013's alternatives record switching to structured output if the live suite shows poor compliance. Who runs the live suite is still open.

## From #115 (coach tool catalogue), defaults taken — NOTE: spending money (Anthropic API) needs the owner's OK before the coach is switched on
- Vercel duration (open question 9). Default: `COACH_MAX_DURATION_S = 180` in `budgets.ts`, which needs Fluid compute on the Hobby plan. Changing that one constant moves every time limit. `turnLimits(60)` is tested as the fallback: 30 s turns, 15 s drafts, 25 s drafting tools.
- Daily cost cap (open question 3). Default: $5 a day, `DAILY_COST_CAP_USD` in `budgets.ts`, counted with `capCostMicros`. The 30 turns per 10 minutes rate limit belongs to coach-turn-endpoint, not this PR.
