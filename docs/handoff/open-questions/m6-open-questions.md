# M6 open questions (defaults taken by the plan; owner may change)

1. Trend thresholds: no verdict before 6 points spanning 21 days, then p < 0.05 and a change of at least the larger of the metric's minimal practical change and twice the noise. The minimal changes are e1RM 2.5 %, weekly volumes 10 %, pace 2 %, load 15 % and adherence 10 points. Confirm these, or name your own.
2. At 4 weeks there are too few points for a fair verdict. Verdicts at 4w therefore look at the last 12 complete weeks and say so, while the numbers and comparisons cover 4 weeks. Is that right, or should 4w show 'Choose 12 weeks or longer for trends' instead?
3. Totals and trends cover complete weeks only. The current week shows apart as 'This week so far', compared with the same days of last week. Is that how you want the week in progress shown?
4. Progress now shows numbers in the units set in your profile, as workout logging does. Before, it used the 'This device' setting. The two differ only if you changed 'This device' alone. Should the device setting win on Progress instead?
5. Workouts you abandoned or are still logging never count toward PRs, totals or reviews. Their sets still show in an exercise's history and in the start kit's 'prior bests'. Is that right, or should abandoned workouts' sets count as training?
6. Progression steps, judged over the last 3 sessions:
- about 1 RPE under target in 2 of the 3 → +2.5 %
- lower body → +5 %, only when all 3 agree and the lift is not in a real decline
- at most +5 % a week
- above target → −2.5 % (−5 % when all 3 are above)
- missed reps hold the first time and reduce by 5 % on a repeat
Confirm these as your coaching defaults.
7. A weekly review becomes available when the week ends, or earlier once every planned session is done or skipped. Do you want the early review, or only after Sunday?
8. If you decide on next week's changes a few days late, the changes for sessions that have already passed are dropped, and the rest are applied. Accepting from the coach inbox sends you to the review to finish instead. Is that right?
9. If a cycle review is created late, the weeks you have already lived through become an 'Unplanned' bridge, and the next block and the blocks after it move back. Before a race, the build is shortened instead, so the race date never moves. Is that the behaviour you want?
10. A next block can only be started from its cycle review, where you choose when it starts. The coach inbox links there and never applies it directly. Confirm.
11. The coach writes up each review once, when you first open it. That is one read-only coach turn per review, in a conversation hidden from your list. 'Discuss with your coach' starts a separate, visible conversation. Is this acceptable, or should the write-up happen only when you tap 'Ask your coach'?
12. If you log training after a review, the review says it is out of date. Refresh makes a new revision and keeps the old one, but only while you have not decided on its adjustments. Confirm.
13. Changing an adjustment means leaving it out or taking a half step. Do you also want to type any amount yourself?
14. Next-week changes are capped at 12 per review, M5's limit for one proposal. Anything beyond that is listed as 'not proposed', with the reason. Is that acceptable, or should a deload count as one change?
15. ACWR is shown with a visible caveat, because its link to injury is debated. Should it be shown as planned, hidden behind 'More', or dropped?
16. Races are taken from best efforts within ±2 % of 5 km, 10 km, half and marathon, plus your reported race results. Should logged runs get an explicit 'race' type instead?
17. When a program has no outline block left, which is the usual case for general goals with no event, the cycle review appends a new block by the rules. Should it instead suggest building a new program?
18. The next block can start this week or next Monday. The default is this week when the block ended last Sunday, which leaves no gap. Is that the default you want?
19. reviews-db waits for M5's coach-explain, because migrations must stay in one order. If coach-explain lands without a migration, may reviews-db merge right after M5's last slice that adds one, by agreement?
20. The brief names a branch, feat/m6-analytics-reviews. This plan ships one PR per slice on m6/NN-* branches into main, as M3–M5 do. Confirm.
