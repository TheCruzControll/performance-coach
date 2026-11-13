/**
 * M3's programming rules (m7/12 rules-registry-m3): every rule the first-block generator and its
 * stages apply, outside rules/ too. A constant entry reads its live export, so its values never
 * drift; a behaviour entry names the exported function that applies a rule with no constant
 * behind it. Each id is the rule key M3's decisions cite (scripts/rule-keys.ts collects them), or,
 * for a constant no decision names, its area and name. Rationales come from the doc comments.
 * The interference rules and placement's order are ./interference.ts's.
 */
import { RELATED_PATTERNS } from '../../alternatives.ts';
import { AVOID_PHRASES, INJURY_EXCLUSIONS } from '../../avoidance.ts';
import { EQUIPMENT_NEEDED } from '../../eligibility.ts';
import { WEEK_KIND_LABEL, WEEK_KINDS } from '../../../training/vocabulary.ts';
import type { WeekKind } from '../../../training/vocabulary.ts';
import {
	FIRST_BLOCK,
	OUTLINES,
	SHORT_EVENT_WEEKS,
	TAPER_LEAD_DAYS,
	weekTargets
} from '../blocks.ts';
import { COMMITMENT_QUOTA, DOUBLES, SESSIONS_WANTED } from '../days.ts';
import { DEFAULTS, GYM_PRESETS } from '../defaults.ts';
import type { DefaultKey } from '../defaults.ts';
import { LOAD_RULES } from '../loads.ts';
import * as running from '../running.ts';
import * as strength from '../strength.ts';
import type { LayoutKey } from '../strength.ts';
import { HARD_SET_RANGES, MAJOR_GROUPS, PHASES, PULL_PER_PUSH } from '../volume.ts';
import type { RuleDefinition } from './types.ts';

const AT = 'src/lib/domain/programming';

/** A constant entry: `source` is 'path#EXPORT' from the programming folder. */
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

const pct = (share: number) => `${Math.round(share * 1000) / 10} %`;

// ---- Days -----------------------------------------------------------------------------------

const days: RuleDefinition[] = [
	constant(
		'days.sessions_wanted',
		'rules/days.ts#SESSIONS_WANTED',
		SESSIONS_WANTED,
		'Each discipline asks for a fewest and a most sessions a week; the free days go to every goal up to its fewest first, then by turns up to its most.',
		'The fewest still move a goal forward (two runs keep running fitness, three sessions train a muscle 10–20 hard sets); beyond the most, a day is better spent on mobility.'
	),
	constant(
		'days.commitment_quota',
		'rules/days.ts#COMMITMENT_QUOTA',
		COMMITMENT_QUOTA,
		'A commitment counts toward its discipline’s quota: a running club is a run, a strength class a strength day, Muay Thai and other classes other sessions.',
		'A class already trains its discipline, so the generator plans around it rather than on top of it; a class sets its own content, so it is credited no hard sets.'
	),
	constant(
		'days.doubles',
		'rules/days.ts#DOUBLES',
		DOUBLES,
		'Two sessions share a day only on a commitment day, at two times (two preferred times, or the other end of the day from a class with a set time when you gave no time), with sessions of 90 minutes or less.',
		'Each session needs its own time, and a day that holds two must still leave recovery between them.'
	),
	behaviour(
		'days.free_days',
		'demand.ts#allocateWeek',
		'The training days besides your commitments are shared out among your goals by priority; a day no goal asks for gets a mobility session.',
		'One day rule for the whole week: days per week counts every training day, commitments included, so the plan never asks for more days than you gave.'
	),
	behaviour(
		'days.commitments_fill',
		'demand.ts#allocateWeek',
		'When your commitments already fill the days you train, no day is added; generated sessions only join them as doubles.',
		'Days per week is the most you train, and your fixed classes already reach it.'
	),
	behaviour(
		'days.dropped',
		'demand.ts#allocateWeek',
		'The lowest-ranked goal short of its fewest sessions is left without them when every free day, and every commitment day with room, is taken.',
		'Fewer sessions than a goal needs are said out loud rather than squeezed into days that cannot hold them.'
	),
	behaviour(
		'days.priority',
		'demand.ts#allocateWeek',
		'A goal ranked above another takes the free days first, so a lower goal may get fewer than its fewest sessions.',
		'Your goal order is the trade-off you chose: the top goal gets what it needs before the rest share what is left.'
	)
];

// ---- Blocks ---------------------------------------------------------------------------------

/** The week kinds M3's first block plans: FIRST_BLOCK's, and a short event's build, taper and event. */
const M3_WEEK_KINDS: readonly WeekKind[] = ['accumulation', 'build', 'deload', 'taper', 'event'];

/** What a week of `kind` asks for, from its live targets (its first step for a building week). */
function targetsOf(kind: WeekKind) {
	const label = WEEK_KIND_LABEL[kind].replace(/ week$/, '');
	if (!M3_WEEK_KINDS.includes(kind)) {
		return `${label} weeks progress by the targets of the block that plans them; M3 plans none.`;
	}
	const t = weekTargets(kind, 0);
	const steps = JSON.stringify(t) !== JSON.stringify(weekTargets(kind, 2));
	const load = t.loadStep
		? `loads ${t.loadStep > 0 ? '+' : '−'}${pct(Math.abs(t.loadStep))}`
		: 'loads held';
	return (
		`${label} weeks: strength to RPE ${t.rpeCap}, ` +
		`${pct(t.volumeFactor)} of the sets, ${load} and running at ${pct(t.runVolumeFactor)} of week 1` +
		(steps ? ' in its first step, each later step a little more.' : '.')
	);
}

const blocks: RuleDefinition[] = [
	constant(
		'blocks.first_block',
		'rules/blocks.ts#FIRST_BLOCK',
		FIRST_BLOCK,
		'With no event shaping it, the first block is a baseline week, three accumulation weeks and a deload.',
		'The baseline week establishes your numbers, three weeks build on them, and the deload absorbs them.'
	),
	constant(
		'blocks.short_event_weeks',
		'rules/blocks.ts#SHORT_EVENT_WEEKS',
		SHORT_EVENT_WEEKS,
		`An event fewer than ${SHORT_EVENT_WEEKS} whole weeks away is too close for a full block: the block builds straight to it from the baseline week and tapers.`,
		'There is no time for a full block and its deload, so the weeks there are go to arriving ready.'
	),
	constant(
		'blocks.taper_lead_days',
		'rules/blocks.ts#TAPER_LEAD_DAYS',
		TAPER_LEAD_DAYS,
		`An event’s taper is the Monday-to-Sunday week holding the day ${TAPER_LEAD_DAYS} days before it.`,
		'So the taper holds most of the seven days before the event: a Saturday fight tapers in its own week, a Monday race in the week before.'
	),
	constant(
		'blocks.outlines',
		'rules/blocks.ts#OUTLINES',
		OUTLINES,
		'After the first block, the outline leads to the next event in phases: base, build, peak and taper for a marathon or half, build, peak and taper for anything else.',
		'The fixed phases are counted back from the event, so the peak and taper always land; the build takes the weeks left.'
	),
	behaviour(
		'blocks.default',
		'blocks.ts#planFirstBlock',
		'With no event date ahead, the first block is the standard start: a baseline week, three that build on it and a deload.',
		'With nothing dated to build toward, the block that suits any goal comes first.'
	),
	behaviour(
		'blocks.short_event',
		'blocks.ts#planFirstBlock',
		`An event under ${SHORT_EVENT_WEEKS} weeks away gets a first block built straight to it from the baseline week, with its taper.`,
		'A full block would not end before the event, so the block ends with it instead.'
	),
	behaviour(
		'blocks.marathon',
		'blocks.ts#planFirstBlock',
		'When a marathon or half is your top dated goal, the first block builds your running base.',
		'Distance running needs its aerobic base before the harder phases the outline leads on to.'
	),
	behaviour(
		'blocks.event',
		'blocks.ts#planFirstBlock',
		'When another event is your top dated goal, the first block builds the base the outline leads on from.',
		'The event is far enough away for a full block first, and the outline plans the rest toward it.'
	),
	behaviour(
		'blocks.outline',
		'blocks.ts#planFirstBlock',
		'An event after the first block gets an outline of phases ending with it; each phase is planned in full when it comes up, and other events are noted in the phase they fall in.',
		'Weeks far ahead depend on how the weeks before go, so they are outlined now and planned from what you log.'
	),
	behaviour(
		'blocks.event_taper',
		'blocks.ts#planFirstBlock',
		`An event inside the first block turns the week holding the day ${TAPER_LEAD_DAYS} days before it into a taper.`,
		'Less volume at the same intensity lets you arrive at the event fresh and sharp.'
	),
	behaviour(
		'goals.paused',
		'blocks.ts#planFirstBlock',
		'A paused goal is left out of the plan, unless every goal is paused, when each is kept at maintenance.',
		'Pausing a goal says it is on hold; training keeps its fitness only when there is nothing else to train for.'
	),
	behaviour(
		'program.baseline_week',
		'generate.ts#generateProgram',
		'Week 1 establishes your baselines: nothing in it goes above its RPE cap, and lifts without a 1RM work up to a top set by RPE.',
		'Your working weights are not known yet, so week 1 finds them safely before the load builds.'
	),
	// One entry per week kind after the baseline, which progression cites as `progression.<kind>`.
	...WEEK_KINDS.filter((kind) => kind !== 'baseline').map((kind) =>
		behaviour(
			`progression.${kind}`,
			'rules/blocks.ts#weekTargets',
			targetsOf(kind),
			'A week’s progression is its targets, data that later stages, M4 and M6 read: building weeks add RPE, load and sets, light weeks take them away.'
		)
	)
];

// ---- Strength -------------------------------------------------------------------------------

const S = 'rules/strength.ts';
const layouts = (Object.keys(strength.LAYOUTS) as LayoutKey[]).map((key) => {
	const layout = strength.LAYOUTS[key];
	return constant(
		`strength.${key}`,
		`${S}#LAYOUTS.${key}`,
		layout,
		`The ${layout.name} split lays out the strength days, by how many there are.`,
		`It ${layout.reason}.`
	);
});
const selected = (
	Object.keys(strength.SELECTED_BECAUSE) as (keyof typeof strength.SELECTED_BECAUSE)[]
).map((key) =>
	constant(
		`strength.${key}`,
		`${S}#SELECTED_BECAUSE.${key}`,
		strength.SELECTED_BECAUSE[key],
		`A main or power slot is filled by this exercise because ${strength.SELECTED_BECAUSE[key]}.`,
		'A main lift is chosen for a reason you can check, in this order: the competition lift, a baseline lift, one you like, then the best match.'
	)
);

const strengthRules: RuleDefinition[] = [
	...layouts,
	constant(
		'strength.styles',
		`${S}#STYLES`,
		strength.STYLES,
		'Sets, reps and rests by slot role: heavy sets with long rests for strength, more reps for size, two sets a slot to keep strength.',
		'Each style trains what its goal needs, and maintenance keeps strength with the fewest hard sets while another goal comes first.'
	),
	constant(
		'strength.own_layout',
		`${S}#OWN_LAYOUT`,
		strength.OWN_LAYOUT,
		'Powerlifting, weightlifting and athletic goals have a split of their own; other strength goals take theirs by the number of days.',
		'A sport’s split is built around how it is tested; general strength fits the days you have.'
	),
	constant(
		'strength.style_of',
		`${S}#STYLE_OF`,
		strength.STYLE_OF,
		'Hypertrophy fills its main slots with the best fit, machines included, in the hypertrophy style; every other strength discipline trains in the strength style.',
		'Building muscle needs hard sets near failure more than a particular lift, so the best match leads.'
	),
	constant(
		'strength.competition_slots',
		`${S}#COMPETITION_SLOTS`,
		strength.COMPETITION_SLOTS,
		'For powerlifting the squat, bench and hinge slots, and for weightlifting the Olympic slot, prefer the competition lift.',
		'A competition lift is a skill practised as it is tested.'
	),
	behaviour(
		'strength.substituted',
		'selection.ts#selectWeek',
		'When the usual exercise for a slot may not be prescribed, its best eligible alternative takes the slot, or else the slot’s best eligible candidate.',
		'An injury, missing equipment or a dislike changes only the slots it rules out, and the slot keeps its training intent.'
	),
	behaviour(
		'strength.disliked',
		'selection.ts#selectWeek',
		'An exercise you dislike is never prescribed.',
		'A plan you enjoy is one you follow; there is nearly always another exercise for the same purpose.'
	),
	behaviour(
		'strength.unmapped_avoidance',
		'selection.ts#selectWeek',
		'A movement to avoid that the coach could not match to any exercise is recorded, so you can say it another way.',
		'Nothing is ruled out silently, and nothing you asked to avoid is ignored silently either.'
	),
	behaviour(
		'strength.slot_empty',
		'selection.ts#selectWeek',
		'When no eligible exercise fits a slot, the slot stays empty with a decision saying why.',
		'An exercise you cannot do safely, or with the kit you have, is worse than none.'
	)
];

// ---- Volume, loads and time -----------------------------------------------------------------

const volume: RuleDefinition[] = [
	...(Object.keys(HARD_SET_RANGES) as (keyof typeof HARD_SET_RANGES)[]).map((style) => {
		const { sets, suits } = HARD_SET_RANGES[style];
		return constant(
			`volume.${style}`,
			`rules/volume.ts#HARD_SET_RANGES.${style}`,
			HARD_SET_RANGES[style],
			`Each major muscle group gets ${sets[0]}–${sets[1]} hard sets a week at full volume for ${suits}.`,
			'A floor that still drives progress and a ceiling that recovery can keep up with; light weeks take their share through their volume factor.'
		);
	}),
	...(['cut', 'bulk'] as const).map((phase) =>
		constant(
			`volume.${phase}`,
			`rules/volume.ts#PHASES.${phase}`,
			PHASES[phase],
			`${PHASES[phase]!.why}.`,
			'Recovery follows what you eat: a deficit recovers fewer sets, a surplus more.'
		)
	),
	behaviour(
		'volume.recomp',
		'volume.ts#balanceBlock',
		'A recomposition phase, like maintenance, keeps the weekly hard-set range as it is.',
		'Eating near maintenance, recovery is what the range already assumes.'
	),
	constant(
		'volume.major_groups',
		'rules/volume.ts#MAJOR_GROUPS',
		MAJOR_GROUPS,
		'The range holds for chest, back, shoulders, quads, hamstrings and hips; work added for one comes from its patterns, isolation first.',
		'The smaller groups get theirs from the compound lifts and the split’s accessories.'
	),
	constant(
		'volume.push_pull',
		'rules/volume.ts#PULL_PER_PUSH',
		PULL_PER_PUSH,
		'Pulling gets at least as many hard sets as pushing.',
		'Balanced pulling protects the shoulders that pressing loads.'
	),
	behaviour(
		'volume.session_length',
		'volume.ts#balanceBlock',
		'Sets are added only while a session stays within its length; when the range cannot fit, a decision says which group falls short.',
		'Your session length is a limit you set, so the plan says what it costs rather than outgrowing it.'
	),
	constant(
		'loads.rules',
		'rules/loads.ts#LOAD_RULES',
		LOAD_RULES,
		'Loads start from a share of your 1RM or a top set by RPE, back-off sets at 90 % of the top set, rounded down to 2.5 %, with a back-off set more in heavier weeks.',
		'A coaching change is a number, and each block stores these rules so M4 and M6 adapt it from data.'
	),
	constant(
		'loads.measured',
		'rules/loads.ts#LOAD_RULES.measuredShare',
		LOAD_RULES.measuredShare,
		`A measured 1RM loads week 1 at ${pct(LOAD_RULES.measuredShare)} of what the RPE table gives its reps at the week’s cap.`,
		'About an RPE under the cap, in case the max has moved since it was tested.'
	),
	constant(
		'loads.estimated',
		'rules/loads.ts#LOAD_RULES.estimateDiscount',
		LOAD_RULES.estimateDiscount,
		`An estimated 1RM loads ${pct(LOAD_RULES.estimateDiscount)} less of it than a measured one, every week.`,
		'An estimate is never treated as a measured max.'
	),
	behaviour(
		'loads.baseline_set',
		'loads.ts#loadBaseline',
		'A main lift with no 1RM works up to a top set by RPE in its first week; every later load is a share of the estimate that set gives.',
		'Guessing a load is riskier than finding it: the top set measures where you are.'
	),
	behaviour(
		'timefit.session_minutes',
		'timefit.ts#fitWeek',
		'Every generated session is fitted to your session length, accessories trimmed first.',
		'The main work matters most, and a session that overruns your time gets cut short where it should not.'
	),
	constant(
		'timefit.time',
		`${S}#TIME`,
		strength.TIME,
		'A session’s time is estimated from a 10-minute warm-up, about 4 seconds a rep and 1 a metre of a carry, plus each set’s rest.',
		'The warm-up includes the main lifts’ ramp-up sets, and a unilateral set is done once per side.'
	),
	constant(
		'timefit.beyond_session_length',
		`${S}#BEYOND_SESSION_LENGTH`,
		strength.BEYOND_SESSION_LENGTH,
		'The long run is not capped by the session length; commitments always keep their own length.',
		'The long run builds the endurance a race needs; to cap it as well, empty this list.'
	)
];

// ---- Running and other sessions -------------------------------------------------------------

const R = 'rules/running.ts';
const runningRules: RuleDefinition[] = [
	constant(
		'running.weekly_increase_max',
		`${R}#RUN_WEEKLY_INCREASE_MAX`,
		running.RUN_WEEKLY_INCREASE_MAX,
		`Each week runs at most ${pct(running.RUN_WEEKLY_INCREASE_MAX)} more than the biggest week before it.`,
		'The 10 % rule: running volume that grows faster than the legs adapt is the commonest road to injury.'
	),
	constant(
		'running.long_run_share_max',
		`${R}#LONG_RUN_SHARE_MAX`,
		running.LONG_RUN_SHARE_MAX,
		`The long run is at most ${pct(running.LONG_RUN_SHARE_MAX)} of the week’s running.`,
		'One run carrying too much of the week stresses the body more than the volume alone suggests.'
	),
	constant(
		'running.long_run_step_max',
		`${R}#LONG_RUN_STEP_MAX`,
		running.LONG_RUN_STEP_MAX,
		`The long run is at most ${pct(running.LONG_RUN_STEP_MAX)} longer than the longest run so far, told or planned.`,
		'The long run grows by the same safe step as the week.'
	),
	constant(
		'running.long_run_length',
		`${R}#LONG_RUN_EXCEEDS_SESSION`,
		running.LONG_RUN_EXCEEDS_SESSION,
		'The long run may run longer than your session length, with a decision saying so; every other run keeps to it.',
		'The long run builds the endurance a distance goal needs (m3-plan open question ‘Session length’).'
	),
	constant(
		'running.efforts',
		`${R}#EFFORTS`,
		running.EFFORTS,
		'Each run segment has an effort: its RPE, its heart-rate zone and its pace as a range of 10K race pace.',
		'Effort can always be followed, even with no pace or race told.'
	),
	constant(
		'running.quality',
		`${R}#QUALITY`,
		running.QUALITY,
		'One quality session a week only for an intermediate or advanced runner or one with a race ahead, with three runs in the week, and never in week 1 for a new runner.',
		'Hard running pays off once easy running is established, and needs easy days around it.'
	),
	constant(
		'running.tempo_run',
		`${R}#QUALITY.tempo`,
		running.QUALITY.tempo,
		'For a half or full marathon the quality session is a 20-minute tempo run at threshold.',
		'Continuous running at threshold builds the pace a long race is run near.'
	),
	constant(
		'running.interval_run',
		`${R}#QUALITY.intervals`,
		running.QUALITY.intervals,
		'For shorter races and general running the quality session is 5 × 3 minutes at VO2max pace with jogged recoveries.',
		'Short hard repeats raise the ceiling a shorter race is run against.'
	),
	behaviour(
		'running.easy_only',
		'running.ts#planRuns',
		'A new runner with no race ahead, or a week with no room for a quality session, runs easy only.',
		'Easy volume comes first; speed work is added when it is safe and fits.'
	),
	behaviour(
		'running.distance_week',
		'running.ts#planRuns',
		'With your weekly running told, week 1 runs that volume, and each later week scales it by its running target.',
		'Starting from what you run now neither undertrains you nor jumps your volume.'
	),
	behaviour(
		'running.time_week',
		'running.ts#planRuns',
		'With no weekly running told, week 1 goes by time and effort: 30-minute easy runs and, unless you are new, a 45-minute long run.',
		'Running by time and effort is safe at any fitness, where a guessed distance may not be.'
	),
	behaviour(
		'running.paces_from_told',
		'running.ts#planRuns',
		'Paces come from your told easy pace and your latest race, as ranges.',
		'Your own numbers set paces you can actually hold.'
	),
	behaviour(
		'running.paces_from_effort',
		'running.ts#planRuns',
		'With no pace or race told, runs carry an RPE and a heart-rate zone and no pace.',
		'A guessed pace could be too fast; effort is right at any fitness.'
	),
	constant(
		'running.marathon_hooks',
		`${R}#MARATHON_HOOKS`,
		running.MARATHON_HOOKS,
		'Each marathon phase carries its progression numbers: how fast running may grow, quality sessions a week and the long run’s share.',
		'Later periodisation adapts a marathon block from these numbers, not from code.'
	),
	constant(
		'other.muay_thai',
		`${R}#MUAY_THAI`,
		running.MUAY_THAI,
		'Generated Muay Thai sessions are technical by default; with your Muay Thai profile they alternate technique and pads, with one sparring session a week in building weeks if you spar.',
		'Technique builds skill without impact, and sparring is kept to the weeks that can absorb it.'
	),
	constant(
		'other.mobility',
		`${R}#MOBILITY`,
		running.MOBILITY,
		`A free day no goal asks for gets a ${running.MOBILITY.minutes}-minute mobility session at RPE ${running.MOBILITY.rpe}.`,
		'An easy session on a spare day helps recovery and costs none.'
	),
	behaviour(
		'other.custom_sessions',
		'other.ts#planOther',
		'A custom-discipline goal with no commitment gets sessions of your session length at RPE 6, their content yours.',
		'The coach plans their time and effort around the rest of your week; you decide what goes in them.'
	),
	behaviour(
		'commitments.fixed',
		'commitments.ts#placeCommitments',
		'Your commitments are placed first, on their own days and times, and keep their own length and intensity.',
		'A class is fixed: everything else is planned around it.'
	)
];

// ---- Placement ------------------------------------------------------------------------------

const placement: RuleDefinition[] = [
	behaviour(
		'placement.no_room',
		'placement.ts#placeSessions',
		'A week with more sessions than days left drops its lowest-priority sessions first.',
		'A session with no day is said out loud rather than crammed into a day that cannot recover from it.'
	),
	behaviour(
		'placement.every_day_clashes',
		'placement.ts#placeSessions',
		'A session for which every day left breaks an avoid rule against a higher-ranked session is dropped.',
		'An avoid rule protects against injury or a session done badly; a lower goal does not outweigh it.'
	),
	behaviour(
		'placement.priority',
		'placement.ts#placeSessions',
		'When a session’s better day clashes with a higher-ranked goal’s session, the higher goal keeps its day and the other is planned around it.',
		'Your goal order is the trade-off you chose.'
	),
	behaviour(
		'placement.priority_kept',
		'placement.ts#placeSessions',
		'When no day avoids every rule, the higher-ranked goal’s session keeps the best day left, with the rule it breaks recorded.',
		'The top goal’s session happens, and the decision says what it costs.'
	)
];

// ---- Defaults and eligibility ---------------------------------------------------------------

const defaults = (Object.keys(DEFAULTS) as DefaultKey[]).map((key) => {
	const rule = DEFAULTS[key];
	const subject = key === 'experience' ? 'a discipline' : 'a commitment';
	const words = (text: string) =>
		text.replaceAll('{subject}', subject).replaceAll('{value}', String(rule.value));
	return constant(
		`defaults.${key}`,
		`rules/defaults.ts#DEFAULTS.${key}`,
		rule,
		`${words(rule.missing)} The coach assumes ${words(rule.assumed)}.`,
		rule.rationale
	);
});

const exercises: RuleDefinition[] = [
	constant(
		'defaults.gym_presets',
		'rules/defaults.ts#GYM_PRESETS',
		GYM_PRESETS,
		'Each gym type is taken to have what nearly every gym of its type has, before you tick anything; a preset only ever adds.',
		'Nothing needing more than a gym is likely to have is prescribed, and anything else is one you tick.'
	),
	constant(
		'exercises.injury_exclusions',
		'avoidance.ts#INJURY_EXCLUSIONS',
		INJURY_EXCLUSIONS,
		'An injury rules out more of the exercises that load its body area the more severe it is: a mild one only the riskiest, a severe one most.',
		'Training around an injury keeps you training without making it worse.'
	),
	constant(
		'exercises.avoid_phrases',
		'avoidance.ts#AVOID_PHRASES',
		AVOID_PHRASES,
		'A movement to avoid that names a kind of movement rules out every exercise of that kind.',
		'You say what to avoid in your own words; bare ‘press’ and ‘pull’ mostly name single exercises, so they are not kinds.'
	),
	constant(
		'exercises.equipment_needed',
		'eligibility.ts#EQUIPMENT_NEEDED',
		EQUIPMENT_NEEDED,
		'An exercise is eligible only with the equipment it needs, and one left out names what it needs.',
		'An exercise you cannot set up is no exercise at all.'
	),
	constant(
		'exercises.related_patterns',
		'alternatives.ts#RELATED_PATTERNS',
		RELATED_PATTERNS,
		'An alternative keeps an exercise’s intent: squats and single-leg knee work stand in for each other.',
		'Both train the knee-dominant lower body, so either keeps a squat’s purpose when the other cannot be done.'
	)
];

export const rules: readonly RuleDefinition[] = [
	...days,
	...blocks,
	...strengthRules,
	...selected,
	...volume,
	...runningRules,
	...placement,
	...defaults,
	...exercises
];
