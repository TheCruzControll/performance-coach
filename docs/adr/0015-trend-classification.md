# 0015 — Trend classification: a Theil–Sen line, a Mann–Kendall p and a minimal change

- **Status:** Accepted (M6, 2026-11-12). Implemented as decided below in
  `src/lib/domain/analytics/trend.ts` (`TREND_METHOD` `theil-sen+mann-kendall/1`, at
  `ANALYTICS_VERSION` 1), and every M6 verdict reads it: the overview and the Strength, Running
  and General views (`domain/analytics/overview.ts` and the services), the weekly and cycle
  reviews, the coach's analytics tools (`services/analytics/index.ts`) and memory's trends
  (`domain/coach/trends.ts`). The thresholds are still the M6 plan's open question to the owner:
  named constants here and each metric's `mpc` in `domain/analytics/metrics.ts`.
- **Context:** Progress, the weekly and cycle reviews, the progression rules and the coach must
  each say whether a figure is really improving, really declining or only varying, and say the
  same thing (PRD §10, §11). Training series are short (6 to 52 weekly points), noisy (an e1RM
  moves a few per cent with sleep and food), often tied (hard sets, adherence points), and now
  and then hold one wild session: a mistyped load, a bad day. The current week is partial, so its
  total always looks low. A stored review keeps its verdicts, so the answer must be
  deterministic, and the owner must be able to read the reason in one sentence.

## Decision

- **One pure function.** `classifyTrend(points, options)` in
  `src/lib/domain/analytics/trend.ts` returns `real_trend` (with `direction` up or down, and
  `good`: whether that is the metric's better way, null for a metric with none),
  `normal_variation`, or `insufficient_data` (with the points and days still `needs`). Every
  result carries `n`, `spanDays`, `slopePerWeek`, `change`, `changePct`, `noise`, `minChange`,
  `p`, `outliers` and the method id `theil-sen+mann-kendall/1` (`TREND_METHOD`).
- **Complete weeks only.** Points marked `inProgress`, and gaps, are dropped before anything else.
  Callers pass the weeks of `trendWindow(period)` (`periods.ts`): a period's own complete weeks
  for 12 weeks and longer, and the last 12 complete weeks for 4 weeks, where the tile says
  'Trend over the last 12 weeks'. Today's week never reaches a verdict, so a Wednesday never
  reads as a decline.
- **The method:**
  1. Availability: at least 6 points (`TREND_MIN_POINTS`) spanning at least 21 days
     (`TREND_MIN_SPAN_DAYS`). With 4 points the smallest two-sided Mann–Kendall p is 0.083, so no
     verdict is possible; with 5 only a perfectly ordered series reaches 0.017, so one session
     out of order decides; 6 tolerate one adjacent swap (S = 13, p = 0.017).
  2. A Theil–Sen slope (the median of all pairwise slopes) through the median intercept, whose
     value on the first day is the line's level.
  3. The Mann–Kendall S and its two-sided p: exact for up to 20 points without ties (the
     Mahonian distribution of inversions, built as probabilities), otherwise the normal
     approximation with Kendall's variance for ties in values and in dates, and a continuity
     correction. Two values on one day are never paired.
  4. noise = 1.4826 × the MAD of the residuals: the usual scatter around the line, as an SD.
  5. A real trend needs p < 0.05 (`TREND_ALPHA`) and |slope × span| ≥ the larger of the metric's
     minimal practical change (MPC) and 2 × noise (`TREND_NOISE_MULTIPLE`). An MPC is absolute,
     relative to the line's level, or both (the larger counts). The metric catalogue holds each
     metric's MPC: e1RM 2.5 %, weekly volumes 10 %, pace 2 %, load 15 %, adherence 10 points.
- **Outliers** beyond 3 robust SDs of the line (`TREND_OUTLIER_SDS`) are flagged and never
  removed: they stay in every figure, and the screens and the coach can name the session. A
  real trend must also be real, the same way, with any one flagged point left out. Without that
  check, one +20 % week at either end of a flat window made a trend 6 to 8 % of the time.
- **Thresholds are named constants** in `trend.ts`, an open question for the owner. A change to
  what the method decides bumps `TREND_METHOD` and `ANALYTICS_VERSION`.

## Measured error rates

From `trend.test.ts`'s seeded generator: 200 seeds a row, 12 weekly points around 100 and
e1RM's MPC (2.5 %) unless the row says otherwise. The tests assert the plan's bound (at least
95 %) on the uniform flat row, the ±1 % rows, a falling pace and the two outlier rows.

| Series                                        | Verdict            | Share                                       |
| --------------------------------------------- | ------------------ | ------------------------------------------- |
| Flat, uniform ±3 %                            | normal variation   | 95.0 % (95.0 % with no MPC; 26 weeks 100 %) |
| Flat, normal SD 3 %                           | normal variation   | 94.0 % (26 weeks 100 %)                     |
| +1 % a week, SD 1 %                           | real, up and good  | 100 %                                       |
| −1 % a week, SD 1 %                           | real, down and bad | 100 %                                       |
| +0.5 % a week, SD 1 %                         | real, up           | 99.5 % (26 weeks 100 %)                     |
| +0.25 % a week, SD 1 %                        | real, up           | 49.0 % (26 weeks 100 %)                     |
| +1 % a week, SD 1 %, 6 weeks                  | real, up           | 46.5 %                                      |
| Flat ±3 %, one +20 % week: first, mid, last   | normal variation   | 98.5 %, 98.5 %, 97.5 %                      |
| +1 % a week, one −20 % week: first, mid, last | real, up           | 100 %, 100 %, 98.5 %                        |

On 12 flat weeks the false-alarm rate (5 to 6 %) is about alpha. The 2 × noise floor removes only
about 1 false alarm in 10 there (the Mann–Kendall p alone gives 5.5 %), because a significant S
over 12 points already implies a change of about two noise SDs; it does its work on longer windows,
where 26 flat weeks almost never trend. The leave-one-out check costs little power (+1 % a week
over 6 weeks: 49.5 % without it, 46.5 % with it). The cost is O(n²) in pairs: about 0.25 ms for 12
points and 1.6 ms for 104 on the development container.

## Alternatives considered

| Option                                         | Why not                                                                                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A least-squares slope with a t-test            | Assumes normal, independent residuals. One wild session moves the slope and inflates its error, and ties and 6 to 12 points push the false-alarm rate off alpha. |
| Rolling-mean bands (a point outside ±2 SD)     | Says whether the last week is unusual, not whether the series moves. It lags, depends on its window, and one session moves both the mean and the band.           |
| Change-point detection (CUSUM, PELT, Bayesian) | Needs more points than 12 weeks give and more tuning, answers 'when did it change' rather than 'is it moving', and is hard to explain in a sentence.             |
| First week against last week                   | Two noisy points decide, so one bad week at either end flips the verdict.                                                                                        |

## Consequences

- Screens and the coach say 'real improvement', 'real decline', 'normal variation' or 'not
  enough data yet: 3 more weeks', with the figures behind each.
- At 12 weeks about 1 flat series in 20 reads as a trend, and a change of 0.25 % a week is found
  half the time; longer windows do better on both. The owner can trade one for the other through
  the constants.
- Every M6 trend reads this one function, so a later change to the method is one PR, with its
  error rates re-measured by the same tests.
