/**
 * M6's programming rules (m7/13 rules-registry-m4-m6): progression from actual results and the
 * fatigue signals (rules/results.ts, applied by results.ts), the weekly and cycle reviews'
 * judgements (review/), next week's adjustments (review/next-week.ts), the cycle directives'
 * bounds (review/directives.ts) and the next block (next-block/ and its stages). A constant entry
 * reads its live export, so its values never drift; a behaviour entry names the exported function
 * that applies a rule with no constant behind it. Each id is the rule key M6's decisions and
 * outcomes cite (scripts/rule-keys.ts collects them), or, for a constant nothing cites, its area
 * and name. Rationales come from the doc comments.
 */
import { DIRECTIVE_RULES } from '../../review/directives.ts';
import {
	DELOAD_AFTER_WEEKS,
	EFFECTIVENESS,
	FATIGUE_WEEKS,
	GOAL_AREAS,
	GOAL_PACE_TYPE,
	HARD_SETS_ON_TARGET,
	VERDICT_MIN_ADHERENCE
} from '../../review/cycle.ts';
import {
	CAPPED_SEGMENTS,
	DELOAD,
	HALF_STEP,
	LIGHT_WEEK_KINDS,
	MAX_NEXT_WEEK_OPS,
	MOVE_SEVERITY,
	PRIORITY,
	SESSIONS_A_DAY
} from '../../review/next-week.ts';
import { MILEAGE_ON_PLAN, PERFORMED_INTENSITY, TRAILING_WEEKS } from '../../review/weekly.ts';
import {
	DEFAULT_NEXT_BLOCK_START,
	MAX_NEXT_BLOCK_WEEKS,
	MIN_NEXT_BLOCK_WEEKS,
	MIN_OUTLINE_WEEKS
} from '../../next-block/dates.ts';
import { SIGNIFICANT } from '../../next-block/generate.ts';
import { NEXT_BLOCK_INPUT_RULES } from '../../next-block/input.ts';
import { BRIDGE_TARGETS } from '../../stages/next-shape.ts';
import { DELOAD_REASON } from '../../stages/results.ts';
import { FATIGUE_RULES, LOWER_BODY_PATTERNS, RESULT_RULES, RUN_RESULT_RULES } from '../results.ts';
import type { RuleDefinition } from './types.ts';

const AT = 'src/lib/domain/programming';

/** A constant entry: `source` is 'path#EXPORT' (or 'path#EXPORT.key') from the programming folder. */
const constant = (
	id: string,
	source: string,
	values: unknown,
	statement: string,
	rationale: string
): RuleDefinition => ({
	id,
	kind: 'constant',
	statement,
	rationale,
	source: `${AT}/${source}`,
	values
});

/** A behaviour entry: `source` is 'path#function' from the programming folder. */
const behaviour = (
	id: string,
	source: string,
	statement: string,
	rationale: string
): RuleDefinition => ({
	id,
	kind: 'behaviour',
	statement,
	rationale,
	source: `${AT}/${source}`
});

const R = RESULT_RULES;
const RUN = RUN_RESULT_RULES;
const RESULTS = 'rules/results.ts#RESULT_RULES';
const DECIDE = 'results.ts#decideFromResults';
const ADAPT = 'results.ts#adaptRunning';
const pct = (share: number) => `${Math.round(share * 1000) / 10} %`;
const signed = (n: number) => `${n > 0 ? '+' : '−'}${Math.abs(n)} %`;

// ---- Strength from results -------------------------------------------------------------------

/** The strength outcomes decideFromResults names, past 'results.'. */
const STRENGTH_RULES = [
	'single',
	'decline',
	'missed_repeat',
	'above_sets',
	'above',
	'above_all',
	'missed_once',
	'below',
	'below_lower',
	'on_target',
	'noisy',
	'reps_hit',
	'no_rpe'
] as const;

const strength: RuleDefinition[] = [
	constant(
		'results.rules',
		RESULTS,
		RESULT_RULES,
		`A lift moves by its last ${R.window} sessions, by at most ${signed(R.maxUp)} and ${signed(-R.maxDown)} a week; a change of ${R.significantPct} % or more waits for all ${R.window}.`,
		'Progression follows what the lift actually showed, never a fixed script, and every step is bounded so one odd week cannot swing a load.'
	),
	constant(
		'results.single',
		`${RESULTS}.minExposures`,
		R.minExposures,
		`A lift with fewer than ${R.minExposures} sessions to judge keeps its planned line.`,
		'Nothing changes on one session: a single day says too little about a lift.'
	),
	constant(
		'results.decline',
		`${RESULTS}.rpeCreep`,
		R.rpeCreep,
		`A real e1RM decline with the RPE rising by ${R.rpeCreep} or more at the same load gets no increase, its accessories ${Math.abs(R.accessorySets)} set fewer, and a deload to consider.`,
		'Getting weaker while the same loads feel harder is accumulated fatigue, which more load would only deepen; a cut still applies.'
	),
	constant(
		'results.missed_repeat',
		`${RESULTS}.missedRepeat`,
		R.missedRepeat,
		`Missed reps in ${R.missedAgree} or more of the sessions take the load ${signed(R.missedRepeat)}.`,
		'Repeatedly missing reps means the load is above what the lift can do today.'
	),
	constant(
		'results.missed_once',
		`${RESULTS}.missedAgree`,
		R.missedAgree,
		`Missed reps in only one session hold the load: it takes ${R.missedAgree} to bring it down.`,
		'One missed session may be a bad day; the next sessions show whether it was a one-off.'
	),
	behaviour(
		'results.above_sets',
		DECIDE,
		'A lift that felt harder than prescribed while every rep was done keeps its load with a set fewer.',
		'The load is still right, since every rep was done; the extra effort says the volume is what to trim.'
	),
	constant(
		'results.above',
		`${RESULTS}.above`,
		R.above,
		`A lift consistently harder than prescribed takes its load ${signed(R.above)}.`,
		'Consistently harder means the load overshoots the target RPE, so it comes down a step.'
	),
	constant(
		'results.above_all',
		`${RESULTS}.aboveAll`,
		R.aboveAll,
		`A lift harder than prescribed in every one of its ${R.window} sessions takes its load ${signed(R.aboveAll)}.`,
		'When every session agrees, the overshoot is clear, so the step is bigger.'
	),
	constant(
		'results.below',
		`${RESULTS}.below`,
		R.below,
		`A lift consistently easier than prescribed takes its load ${signed(R.below)}.`,
		'Consistently easier means the load undershoots the target RPE, so it goes up a step.'
	),
	constant(
		'results.below_lower',
		`${RESULTS}.belowLower`,
		R.belowLower,
		`A lower-body lift easier than prescribed in all ${R.window} sessions takes its load ${signed(R.belowLower)}.`,
		'Squats, hinges and lunges move bigger loads, so the same agreement earns a bigger step.'
	),
	constant(
		'results.lower_body',
		'rules/results.ts#LOWER_BODY_PATTERNS',
		LOWER_BODY_PATTERNS,
		`Lifts of these patterns are lower body: ${LOWER_BODY_PATTERNS.join(', ')}.`,
		'They are the lifts whose loads are large enough for the bigger step to be one plate, not a jump.'
	),
	constant(
		'results.on_target',
		`${RESULTS}.onTarget`,
		R.onTarget,
		`A lift within ${R.onTarget} RPE of target in every session follows the planned progression.`,
		'On target means the plan is working, so the plan decides the next step.'
	),
	behaviour(
		'results.noisy',
		DECIDE,
		'A lift around its target, easier one session and harder another, holds.',
		'Chasing noise would move the load up and down for nothing; the trend decides once it shows.'
	),
	behaviour(
		'results.reps_hit',
		DECIDE,
		`A lift with too few RPEs logged goes up a step when every set reached its target in ${R.missedAgree} or more sessions.`,
		'Without effort ratings, hitting every rep is the best evidence the load is not too heavy.'
	),
	behaviour(
		'results.no_rpe',
		DECIDE,
		'A lift with too few RPEs logged, and too few sessions on target, holds.',
		'With neither ratings nor reps to go on, there is no evidence to move it either way.'
	),
	...STRENGTH_RULES.map((rule) =>
		behaviour(
			`results.${rule}.at_limit`,
			DECIDE,
			`When no load, rep or set step fits this week's limits, a lift under results.${rule} holds rather than break them.`,
			'The weekly caps and the significant-change wait keep every step bounded; an outcome that cannot fit them waits for next week.'
		)
	)
];

// ---- Running from results --------------------------------------------------------------------

const running: RuleDefinition[] = [
	behaviour(
		'results.run.planned',
		ADAPT,
		"Next week's distance stays as planned when it is within the weekly cap and adherence was high enough.",
		'When last week went as planned, the plan’s own ramp decides.'
	),
	constant(
		'results.run.weekly_cap',
		'rules/results.ts#RUN_RESULT_RULES.maxWeeklyRise',
		RUN.maxWeeklyRise,
		`Next week's distance rises at most ${pct(RUN.maxWeeklyRise)} over what was actually run last week, rounded down to ${RUN.roundMetres} m.`,
		'Mileage built on what you ran, not what was planned, keeps the rise sustainable.'
	),
	constant(
		'results.run.adherence_hold',
		'rules/results.ts#RUN_RESULT_RULES.holdBelowAdherence',
		RUN.holdBelowAdherence,
		`Under ${RUN.holdBelowAdherence} % of last week's sessions completed, next week's volume holds at last week's plan.`,
		'A week mostly missed is no base to build on; the volume waits until the sessions are done.'
	),
	behaviour(
		'results.long_run.repeat',
		ADAPT,
		'A missed long run is repeated at its distance before the long run steps up.',
		'The long run grows only on one completed; skipping a step would build on a run never done.'
	),
	behaviour(
		'results.long_run.hold',
		ADAPT,
		'A long run not done at or under its target RPE stays at its distance before it steps up.',
		'A long run that felt too hard is not yet easy at that distance, so it is not lengthened.'
	),
	behaviour(
		'results.long_run.no_rpe',
		ADAPT,
		'A long run with no RPE to check against its target stays at its distance before it steps up.',
		'Without a rating, nothing shows the distance was comfortable enough to lengthen.'
	),
	behaviour(
		'results.long_run.planned',
		ADAPT,
		'The long run follows the plan when the last one was completed at or under its target RPE.',
		'An easy enough long run is the evidence the next step is safe.'
	)
];

// ---- Fatigue ---------------------------------------------------------------------------------

const fatigue: RuleDefinition[] = [
	constant(
		'results.fatigue_signals',
		'rules/results.ts#FATIGUE_RULES.signals',
		FATIGUE_RULES.signals,
		'The fatigue signals: a high acute:chronic ratio, monotony, soreness, short sleep, RPE creep, lifts missing reps and declining lifts, each with its threshold.',
		'Each is a recognised sign that recovery is falling behind training; the acute:chronic ratio is a rough guide, not an injury predictor.'
	),
	constant(
		'results.fatigue_high',
		'rules/results.ts#FATIGUE_RULES.highSignals',
		FATIGUE_RULES.highSignals,
		`Fatigue is watch with one signal met and high, which recommends a deload, with ${FATIGUE_RULES.highSignals} or more.`,
		'One sign may be a bad night or a hard week; several together are a pattern worth a lighter week.'
	)
];

// ---- Next week -------------------------------------------------------------------------------

const NEXT_WEEK = 'review/next-week.ts';
const nextWeek: RuleDefinition[] = [
	constant(
		'next_week.deload',
		`${NEXT_WEEK}#DELOAD`,
		DELOAD,
		`High fatigue on a normal week deloads the main lifts: ${Math.round((1 - DELOAD.setsFactor) * 100)} % fewer sets and RPE at most ${DELOAD.rpeCap}; a deloaded week takes no progression.`,
		'High fatigue recommends a deload, and cutting the main lifts’ volume and effort clears it fastest without stopping training.'
	),
	constant(
		'next_week.light_weeks',
		`${NEXT_WEEK}#LIGHT_WEEK_KINDS`,
		LIGHT_WEEK_KINDS,
		`In a week already light (${LIGHT_WEEK_KINDS.join(', ')}), high fatigue only caps the main lifts' RPE at ${DELOAD.rpeCap} and flags the cycle review.`,
		'A week that is already light needs no second cut; if fatigue stays high through it, the next block should know.'
	),
	constant(
		'next_week.max_ops',
		`${NEXT_WEEK}#MAX_NEXT_WEEK_OPS`,
		MAX_NEXT_WEEK_OPS,
		`At most ${MAX_NEXT_WEEK_OPS} changes are proposed for next week, the more important first; the rest are listed as not proposed, with the reason.`,
		'One proposal holds up to M5’s limit, and a short list is one the owner can actually review.'
	),
	constant(
		'next_week.priority',
		`${NEXT_WEEK}#PRIORITY`,
		PRIORITY,
		'Past the limit, changes keep their place in this order: a deload, running, a reduction, a move, then an increase.',
		'Changes that protect recovery matter more than ones that add load, so they are never the ones left out.'
	),
	constant(
		'next_week.half_step',
		`${NEXT_WEEK}#HALF_STEP`,
		HALF_STEP,
		`Each change can be taken as proposed, at a half step (${pct(HALF_STEP)} of the way, on the field's grain), or left out.`,
		'A middle option lets the owner soften a change without typing an amount the rules never checked.'
	),
	constant(
		'next_week.capped_segments',
		`${NEXT_WEEK}#CAPPED_SEGMENTS`,
		CAPPED_SEGMENTS,
		`The weekly running cap shortens only ${CAPPED_SEGMENTS.join(', ')} segments, never the quality work.`,
		'Easy volume is what to trim when mileage rises too fast; the quality sessions carry the training effect.'
	),
	constant(
		'next_week.move_severity',
		`${NEXT_WEEK}#MOVE_SEVERITY`,
		MOVE_SEVERITY,
		`Only a rule to keep (severity ${MOVE_SEVERITY}) is resolved by moving a session; advice is left as planned.`,
		'A move changes the owner’s week, so it is proposed only for a conflict worth fixing.'
	),
	constant(
		'next_week.sessions_a_day',
		`${NEXT_WEEK}#SESSIONS_A_DAY`,
		SESSIONS_A_DAY,
		`A proposed move never puts more than ${SESSIONS_A_DAY} sessions on one day.`,
		'It is the most sessions a day the plan schema holds, so a move never proposes a day the plan would refuse.'
	)
];

// ---- Reviews ---------------------------------------------------------------------------------

const reviews: RuleDefinition[] = [
	constant(
		'review.trailing_weeks',
		'review/weekly.ts#TRAILING_WEEKS',
		TRAILING_WEEKS,
		`The weekly review's verdicts read the ${TRAILING_WEEKS} complete weeks before the reviewed one.`,
		'Two months is enough to see a trend and short enough to reflect current training.'
	),
	constant(
		'review.mileage_on_plan',
		'review/weekly.ts#MILEAGE_ON_PLAN',
		MILEAGE_ON_PLAN,
		`Mileage at ${pct(MILEAGE_ON_PLAN)} of the plan or more is on plan.`,
		'A run cut a little short is still the week’s work done; only a real shortfall is flagged.'
	),
	constant(
		'review.performed_intensity',
		'review/weekly.ts#PERFORMED_INTENSITY',
		PERFORMED_INTENSITY,
		'A logged session’s RPE reads as a planned intensity for the interference rules: 9 very hard, 7 hard, 5 moderate, else easy, and moderate without an RPE.',
		'M3’s rules were written for plans; this is the one bridge from a performed week to them.'
	),
	constant(
		'review.verdict_min_adherence',
		'review/cycle.ts#VERDICT_MIN_ADHERENCE',
		VERDICT_MIN_ADHERENCE,
		`Under ${VERDICT_MIN_ADHERENCE} % adherence the block is too thin to judge, and the cycle review withholds its verdicts.`,
		'A block mostly missed says little about whether its programming works.'
	),
	constant(
		'review.effectiveness',
		'review/cycle.ts#EFFECTIVENESS',
		EFFECTIVENESS,
		`An exercise is judged by its e1RM over at least ${EFFECTIVENESS.minExposures} sessions, and held or regressed over ${EFFECTIVENESS.stallExposures} or more is stalled.`,
		'Comparing the later half of its sessions with the earlier half shows real change; fewer sessions are too few to call.'
	),
	constant(
		'review.fatigue_weeks',
		'review/cycle.ts#FATIGUE_WEEKS',
		FATIGUE_WEEKS,
		`Recovery notes are read over the block's last ${FATIGUE_WEEKS} weeks.`,
		'Accumulated fatigue shows at the end of a block.'
	),
	constant(
		'review.deload_after_weeks',
		'review/cycle.ts#DELOAD_AFTER_WEEKS',
		DELOAD_AFTER_WEEKS,
		`A block of ${DELOAD_AFTER_WEEKS} weeks or more with no light week suggests a deload, and a next block that long ends with one.`,
		'Hard weeks without a break let fatigue pile up; a lighter week lets the work sink in.'
	),
	constant(
		'review.hard_sets_on_target',
		'review/cycle.ts#HARD_SETS_ON_TARGET',
		HARD_SETS_ON_TARGET,
		`A hypertrophy goal is on target when ${pct(HARD_SETS_ON_TARGET)} of its group-weeks are within range.`,
		'Most weeks in range is what grows muscle; one off week does not undo a block.'
	),
	constant(
		'review.goal_pace_type',
		'review/cycle.ts#GOAL_PACE_TYPE',
		GOAL_PACE_TYPE,
		`A running goal's target race pace is compared with the pace of its ${GOAL_PACE_TYPE.replace('_', ' ')}s.`,
		'Tempo runs are the everyday sessions closest to race effort, so their pace tracks progress toward it.'
	),
	constant(
		'review.goal_areas',
		'review/cycle.ts#GOAL_AREAS',
		GOAL_AREAS,
		'Each goal is measured by its area: strength by e1RM, hypertrophy by hard sets, running by pace and Muay Thai by sessions, by the disciplines that train it.',
		'A goal is judged by what it is for, so the review measures the thing the goal is trying to move.'
	)
];

// ---- Cycle directives ------------------------------------------------------------------------

const DIRECTIVES = 'review/directives.ts#DIRECTIVE_RULES';
const D = DIRECTIVE_RULES;
const directives: RuleDefinition[] = [
	constant(
		'directives.append_weeks',
		`${DIRECTIVES}.appendWeeks`,
		D.appendWeeks,
		`With no outline block left, the next block is appended by the rules with ${D.appendWeeks} weeks, as many as M3's first block.`,
		'The plan keeps going rather than stopping; a new program stays the owner’s choice.'
	),
	constant(
		'directives.volume_step',
		`${DIRECTIVES}.volumeStep`,
		D.volumeStep,
		`A muscle group's hard sets move by ${pct(D.volumeStep)} when its block mean was outside its range.`,
		'A small step toward the range corrects volume without a jump the body has not adapted to.'
	),
	constant(
		'directives.fatigue_volume_cut',
		`${DIRECTIVES}.fatigueVolumeCut`,
		D.fatigueVolumeCut,
		`High fatigue takes ${pct(Math.abs(D.fatigueVolumeCut))} off every group's volume in the next block.`,
		'A block that ended fatigued should start with less work, not more.'
	),
	constant(
		'directives.rpe',
		`${DIRECTIVES}.rpe`,
		D.rpe,
		`The next block's target RPE range follows the last block's fatigue: ${D.rpe.none.join('–')} with none, ${D.rpe.watch.join('–')} at watch and ${D.rpe.high.join('–')} when high.`,
		'More fatigue means training a little further from failure until it clears.'
	),
	constant(
		'directives.run_weeks',
		`${DIRECTIVES}.runWeeks`,
		D.runWeeks,
		`Running in the next block starts from the mean of the last ${D.runWeeks} weeks' actual distance.`,
		'Starting from what was run, not what was planned, keeps the next block’s mileage realistic.'
	),
	constant(
		'directives.load_step',
		`${DIRECTIVES}.loadStep`,
		D.loadStep,
		`A strength week's load step while progressing is ${pct(D.loadStep)}.`,
		'Small weekly steps compound, and stay small enough that a lift keeps up with them.'
	),
	constant(
		'directives.load_step_min',
		`${DIRECTIVES}.loadStepMin`,
		D.loadStepMin,
		`The deepest load step an override may ask for is a ${pct(Math.abs(D.loadStepMin))} cut a week.`,
		'A bigger cut is a different program, not an adjustment.'
	),
	constant(
		'directives.volume_factor_min',
		`${DIRECTIVES}.volumeFactorMin`,
		D.volumeFactorMin,
		`The lightest volume an override may ask for is ${pct(D.volumeFactorMin)} of the sets, a deload's.`,
		'Less than a deload would stop training, not adjust it.'
	),
	constant(
		'directives.min_weeks',
		`${DIRECTIVES}.minWeeks`,
		D.minWeeks,
		`An appended block has at least ${D.minWeeks} weeks, and no block one review plans has more than ${D.maxWeeks}.`,
		'Shorter blocks have no room to build; longer ones are planned for their first weeks and reviewed again.'
	),
	behaviour(
		'results.deload_first',
		'review/directives.ts#directivesFrom',
		'The next block opens with a deload week when the cycle review finds one needed.',
		DELOAD_REASON.first
	),
	behaviour(
		'results.deload_last',
		'review/directives.ts#directivesFrom',
		'The next block ends with a deload week when the cycle review says to consider one, or the block is long.',
		DELOAD_REASON.last
	)
];

// ---- Next block ------------------------------------------------------------------------------

const nextBlock: RuleDefinition[] = [
	behaviour(
		'next_block.planned',
		'next-block/generate.ts#generateNextBlock',
		'The next block is the phase the plan outlined, or the one the rules plan after the last; weeks since the last block are left unplanned between blocks.',
		'The plan continues from where training is now, and a late start says what it costs before an event.'
	),
	constant(
		'next_block.hard_sets',
		'next-block/generate.ts#SIGNIFICANT.hardSets',
		SIGNIFICANT.hardSets,
		`A muscle group whose weekly hard sets change by ${SIGNIFICANT.hardSets} or more is a significant change, explained by its own decision.`,
		'A change that large is one the owner should see and be told why.'
	),
	constant(
		'next_block.significant',
		'next-block/generate.ts#SIGNIFICANT',
		SIGNIFICANT,
		`A significant change: a load moved ${SIGNIFICANT.loadPct} % or more by results, ${SIGNIFICANT.hardSets} or more hard sets a week, or a ${pct(SIGNIFICANT.runVolume)} run volume change; a swap, a phase change, a deload and a bridge always count.`,
		'The cycle review lists what moved enough to matter, so the owner reviews those, not every small step.'
	),
	behaviour(
		'carryover.kept',
		'stages/carryover.ts#carryover',
		'An exercise the cycle review keeps stays in the next block, in its old slot when selection did not place it, unless it may no longer be prescribed.',
		'An exercise that is working is worth keeping, so the next block carries it on.'
	),
	behaviour(
		'carryover.rotated',
		'stages/carryover.ts#carryover',
		'An exercise the cycle review rotates gives its slots to the top-ranked eligible alternative; a main lift and a liked exercise are never rotated.',
		'Rotating a stalled accessory brings a fresh stimulus while the main lifts stay to measure progress.'
	),
	constant(
		'next_block.input_rules',
		'next-block/input.ts#NEXT_BLOCK_INPUT_RULES',
		NEXT_BLOCK_INPUT_RULES,
		`The next block's running starts from the last ${NEXT_BLOCK_INPUT_RULES.runWeeks} complete weeks, and its easy pace from the last ${NEXT_BLOCK_INPUT_RULES.easyRuns} easy runs.`,
		'The block starts from what training actually showed, not the profile’s first answers.'
	),
	constant(
		'next_block.default_start',
		'next-block/dates.ts#DEFAULT_NEXT_BLOCK_START',
		DEFAULT_NEXT_BLOCK_START,
		`The start offered first is ${DEFAULT_NEXT_BLOCK_START.replace('_', ' ')}.`,
		'It leaves no gap when the block ended last Sunday.'
	),
	constant(
		'next_block.min_weeks',
		'next-block/dates.ts#MIN_NEXT_BLOCK_WEEKS',
		MIN_NEXT_BLOCK_WEEKS,
		`An event build's next block is never shortened below ${MIN_NEXT_BLOCK_WEEKS} weeks while weeks remain.`,
		'A block shorter than that has no room to build before the taper.'
	),
	constant(
		'next_block.min_outline_weeks',
		'next-block/dates.ts#MIN_OUTLINE_WEEKS',
		MIN_OUTLINE_WEEKS,
		`No later block before the event is shortened below ${MIN_OUTLINE_WEEKS} week.`,
		'Every outlined phase keeps at least a week, so the plan’s shape to the event stays whole.'
	),
	constant(
		'next_block.max_weeks',
		'next-block/dates.ts#MAX_NEXT_BLOCK_WEEKS',
		MAX_NEXT_BLOCK_WEEKS,
		`One review plans at most ${MAX_NEXT_BLOCK_WEEKS} weeks; the rest of a longer outline block stays outline for the next review.`,
		'A review plans what it can judge; later weeks are planned from later results.'
	),
	constant(
		'next_block.bridge_targets',
		'stages/next-shape.ts#BRIDGE_TARGETS',
		BRIDGE_TARGETS,
		`An unplanned week between blocks asks for no volume, with an RPE cap of ${BRIDGE_TARGETS.rpeCap}.`,
		'Nothing is planned in it, so nothing is asked; the cap still reads as easy should a session be logged.'
	)
];

export const rules: readonly RuleDefinition[] = [
	...strength,
	...running,
	...fatigue,
	...nextWeek,
	...reviews,
	...directives,
	...nextBlock
];
