# M7 open questions (answered with defaults; each slice lists its default under "## Owner decisions")

1. Event proximity: inside its lead window, an event goal leads ahead of a higher-ranked goal whose event is further away, and the plan explains it every time. The windows are fight 8 weeks, half 12, marathon 16, meet 10 and other race 6. Confirm these windows, or should your rank always win?
2. The coaching numbers are defaults, all listed in the rules reference:
- load model: the system shares, and the recovery half-lives (lower 2.5 days, upper 2, aerobic 1.5, combat 2, CNS 2)
- the acute:chronic ratio is the one Progress already shows (7- and 28-day averages), so it appears only after 28 days of training history; before that, only the half-lives judge fatigue
- overload at 1.5 × your own 28-day load
- evaluation costs: avoid 25 and prefer 8
- rank weights: 1, 0.6, 0.4, 0.25 and 0.15
Keep them?
3. Same-day order: when a day holds strength and a hard endurance or Muay Thai session, the higher-ranked goal's session goes first, at least 6 hours apart. M3 always put the run or the Muay Thai first. Confirm the 6 hours, and that strength goes first only when it ranks higher.
4. Re-plans for new priorities, a chosen block or a taper start on the next Monday with nothing logged from it, so the week in progress is never rewritten. Only a deload changes the week in progress, and only its sessions still ahead. Do you also want a 'from tomorrow' option for the others?
5. A re-plan for new priorities replaces the future weeks, including your own moves in them, and the proposal lists each one. Should your moves be carried over where they still fit instead?
6. Pausing or resuming a goal, changing an event date, and an accepted coach goal_update also propose a re-plan, not only a reorder. Is that right?
7. When the weekly review finds high fatigue or a real decline, it proposes a deload of the week after the reviewed one instead of M6's −40 % sets on the main lifts. The deload has lighter targets, no sparring and easy runs. If you review on Monday or later, only the sessions still ahead change. If a planned deload, taper, event or recovery week starts in that week or the two after it, M6's lighter adjustment is kept and the planned week does the rest. Confirm.
8. The weekly review now also judges its week and checks the moves it proposes with the new rules, on what you actually logged, so it may list a few more conflicts than before (for example hard sparring the day before heavy squats). Reviews stored earlier keep what they said. Is that right?
9. Deload cadence: a deload after every 5 loading weeks for a new lifter, 4 for novice and intermediate, and 3 for advanced, plus one at each block's end. Confirm.
10. Tapers:
- marathon: 3 weeks at 80/60/40 %
- half: 2 weeks at 70/50 %
- shorter races, meets and fights: 1 week; sparring stops at least 7 days before a fight
- a secondary event: a 3-day mini-taper
- a low-priority event: trained through, unless you ask the coach to taper it
Confirm.
11. Marathon defaults: at most +10 % a week, with one exception: regaining a level held in the last 8 weeks, at up to +20 %, always stated. A cutback every 4th week at 80 %, and a long run capped at 32 km or 3 hours. A half's build has 2 quality sessions a week. Confirm.
12. Marathon-pace work uses the existing 'Steady' segment type at your marathon pace, labelled 'at marathon pace', so workout logging and Progress need no new run type. Or do you want a separate 'Marathon pace' segment type everywhere?
13. Fight camp: 6–8 weeks, at most 2 hard sparring sessions a week, the last at least 7 days before the fight, and weight cutting out of scope. Confirm.
14. Maintenance doses reuse the program's existing maintenance style:
- strength and building muscle at maintenance: 1–2 'Keep' sessions, 2 sets an exercise, 4–10 hard sets per muscle group, with the main lifts' top set capped at RPE 8
- a secondary strength goal (one that does not lead but does not conflict with the leader) keeps its own split and style, at the lower half of its usual range: 8–11 sets for strength, 10–15 for building muscle
- running: 60–70 % of recent volume, with at most one quality session
- Muay Thai: technique and pads, with no sparring unless it is your class
In the four-goal example, build muscle is held at maintenance through fight camp and marathon build. Is that the trade-off you want?
15. Maintenance blocks hold every goal at its dose. They fill gaps of under 4 weeks between events, follow your last event when no goal wants a building block, make up an off-season of 'keep' goals, and are the whole plan when every goal is paused, as today. Should the season instead return to a building block for your top-ranked undated goal after the last event?
16. Heart rate: three optional fields in Profile → Running and in onboarding's running step (max, resting and threshold heart rate; one migration). Zones prefer threshold, then heart-rate reserve, then max. Or should zones come only from heart rate recorded in your runs?
17. Training paces move from Riegel to Daniels' VDOT, from your best race of the last 26 weeks (52 weeks at low confidence). A race with no date counts only when no dated race exists, and is treated as a rough guide. Confirm.
18. Train shows findings only for days still ahead, never for sessions already done, and shows no week summary on past weeks, outline weeks or bridge weeks. Is that right?
19. A block that a re-plan cuts short gets no cycle review of its own; the block that replaces it is reviewed at its end. Confirm.
20. A plan holds at most 10 blocks, counting past ones, so a year or more of re-plans can eventually ask you to start a new program from Today. Is that acceptable, or should old blocks be folded away instead?
21. Branches: the brief names feat/m7-advanced-coaching. This plan ships one PR per slice on m7/NN-* branches into main, as M3–M6 do. Confirm.
