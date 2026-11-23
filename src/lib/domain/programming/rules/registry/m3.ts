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
import * as added from '../added.ts';
import { COMMITMENT_QUOTA, DOUBLES, OTHER_END_OF_DAY, SESSIONS_WANTED } from '../days.ts';
import { DEFAULTS, GYM_PRESETS } from '../defaults.ts';
import type { DefaultKey } from '../defaults.ts';
import { LOAD_RULES } from '../loads.ts';
import * as running from '../running.ts';
import * as strength from '../strength.ts';
import type { LayoutKey } from '../strength.ts';
import {
	HARD_SET_RANGES,
	MAJOR_GROUPS,
	MAX_ADDED_EXERCISES,
	MAX_LINE_SETS,
	PHASES,
	PULL_PATTERNS,
	PULL_PER_PUSH,
	PUSH_PATTERNS,
	VOLUME_WEEK_MIN
} from '../volume.ts';
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

/** 'a, b and c', or with `or`; 'a, b and c, and d' when an item holds the conjunction itself. */
const list = (items: readonly string[], conjunction = 'and') => {
	if (items.length < 2) return items.join('');
	const serial = items.some((item) => item.includes(` ${conjunction} `)) ? ',' : '';
	return `${items.slice(0, -1).join(', ')}${serial} ${conjunction} ${items[items.length - 1]}`;
};

/** An RPE per intent or intensity, as '6 when easy, 7 when moderate and 8 when hard'. */
const rpeWhen = (byIntent: Readonly<Record<string, number>>) =>
	list(Object.entries(byIntent).map(([intent, rpe]) => `${rpe} when ${intent}`));

/** Seconds per km as m:ss. */
const paceOf = (seconds: number) =>
	`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

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
		'Each run segment has an effort: its RPE and its heart-rate zone. Its pace comes from your current VDOT (rules/paces.ts SEGMENT_PACES), and a recovery jog has none.',
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
		'running.zone2_bike',
		`${R}#ZONE2_BIKE`,
		running.ZONE2_BIKE,
		`With a bike, and runs that serve a goal training more than running, half of each week's generated easy runs (rounded up, the latest first) become a zone 2 bike session of the same length; every week keeps at least ${running.ZONE2_BIKE.keepRuns} run, and a goal about running or with a race ahead keeps its easy runs.`,
		'The bike gives the same easy aerobic work without the impact, so the legs stay fresher for lifting and Muay Thai.'
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
		'With no recent race, paces come from the VDOT your told easy pace implies, as ranges.',
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

// ---- Numbers no decision cites (m7/58 rules-reference) ---------------------------------------
// Every export of rules/ is a registered rule or a listed non-rule
// (scripts/programming-rules-doc.test.ts), so these coaching numbers are registered here too.

const dayNumbers: RuleDefinition[] = [
	constant(
		'days.other_end_of_day',
		'rules/days.ts#OTHER_END_OF_DAY',
		OTHER_END_OF_DAY,
		'Beside a commitment at a set time, with no preferred time (‘it varies’), a second session goes at the other end of the day: after an early-morning, morning or midday commitment in the evening, after an afternoon or evening one in the morning. With one preferred time, it goes at that time only if it is at the other end of the day from the commitment; otherwise there is no second session.',
		'Two sessions in one day recover best far apart, so the second goes as far from the first as the day allows.'
	)
];

/** LAYOUT_BY_DAYS as 'full-body up to 3, upper/lower at 4 … and push/pull/legs from 6'. */
const layoutByDays = list(
	strength.LAYOUT_BY_DAYS.map(([most, key], i) => {
		const fewest = i === 0 ? null : strength.LAYOUT_BY_DAYS[i - 1]![0] + 1;
		const days =
			fewest === null
				? `up to ${most}`
				: most === Infinity
					? `from ${fewest}`
					: most === fewest
						? `at ${most}`
						: `from ${fewest} to ${most}`;
		return `${strength.LAYOUTS[key].name} ${days}`;
	})
);

/** INTENSITY_BY_RPE as 'under 6.5 easy … and very hard from 9': a row matches a cap under its bound. */
const intensityByRpe = list(
	strength.INTENSITY_BY_RPE.map(([under, intensity], i) => {
		const name = intensity.replace('_', ' ');
		return under === Infinity
			? `${name} from ${strength.INTENSITY_BY_RPE[i - 1]![0]}`
			: `under ${under} ${name}`;
	})
);

const strengthNumbers: RuleDefinition[] = [
	constant(
		'strength.slot_kinds',
		`${S}#SLOT_KINDS`,
		strength.SLOT_KINDS,
		'Each slot is filled by the movement patterns it names: squat, hinge, single-leg, horizontal and vertical push and pull, core, and each isolation slot by its muscles.',
		'Filling slots by pattern keeps a session balanced whichever exercise fills each one.'
	),
	constant(
		'strength.days',
		`${S}#DAYS`,
		strength.DAYS,
		'Each strength day holds its slots in order, main lifts first, then secondary work and accessories; the splits pick their days from these.',
		'Main lifts go first, while you are fresh, and each day trains a balanced set of patterns.'
	),
	constant(
		'strength.layout_by_days',
		`${S}#LAYOUT_BY_DAYS`,
		strength.LAYOUT_BY_DAYS,
		`Without a split of its own, strength goes by its number of days: ${layoutByDays}.`,
		'Each layout trains every muscle about twice a week at that many days, the frequency strength and size respond to best.'
	),
	constant(
		'strength.general_style',
		`${S}#GENERAL_STYLE`,
		strength.GENERAL_STYLE,
		'Every strength discipline trains in the strength style, with your baseline lifts in its main slots, unless it has a style of its own.',
		'Most strength goals are judged by the main lifts, so those lifts lead the sessions.'
	),
	constant(
		'strength.working_rpe',
		`${S}#WORKING_RPE`,
		strength.WORKING_RPE,
		`Work other than the top and back-off sets is held to RPE ${strength.WORKING_RPE}, or the week’s cap if that is lower.`,
		'Secondary and accessory work supports the main lifts, so it stops a few reps short of failure and leaves recovery for them.'
	),
	constant(
		'strength.intensity_by_rpe',
		`${S}#INTENSITY_BY_RPE`,
		strength.INTENSITY_BY_RPE,
		`A strength session’s intensity comes from its week’s RPE cap: ${intensityByRpe}.`,
		'How hard a week may go sets how hard its sessions are, so the interference rules and the load model read each session by it.'
	),
	constant(
		'strength.default_metres',
		`${S}#DEFAULT_METRES`,
		strength.DEFAULT_METRES,
		`A carry or sled set is ${strength.DEFAULT_METRES} metres.`,
		'The library gives carries and sleds no distance, and that is a common working distance that fits in a gym.'
	)
];

const volumeNumbers: RuleDefinition[] = [
	constant(
		'volume.week_min',
		'rules/volume.ts#VOLUME_WEEK_MIN',
		VOLUME_WEEK_MIN,
		'A group’s hard-set range holds only in full-volume weeks, whose volume factor is at least 1.',
		'A deload or taper week is meant to fall below the range, so it is not held to it.'
	),
	constant(
		'volume.push_patterns',
		'rules/volume.ts#PUSH_PATTERNS',
		PUSH_PATTERNS,
		'Pushing is counted from the horizontal and vertical push patterns.',
		'Pulling is balanced against pushing set for set, so both must be counted the same way.'
	),
	constant(
		'volume.pull_patterns',
		'rules/volume.ts#PULL_PATTERNS',
		PULL_PATTERNS,
		'Pulling is counted from the horizontal and vertical pull patterns.',
		'Pulling is balanced against pushing set for set, so both must be counted the same way.'
	),
	constant(
		'volume.max_line_sets',
		'rules/volume.ts#MAX_LINE_SETS',
		MAX_LINE_SETS,
		`No exercise grows past ${MAX_LINE_SETS} sets in a session: more work for a group comes as another exercise.`,
		'Past about five hard sets an exercise’s later sets add little, so another exercise spreads the work.'
	),
	constant(
		'volume.max_added_exercises',
		'rules/volume.ts#MAX_ADDED_EXERCISES',
		MAX_ADDED_EXERCISES,
		`At most ${MAX_ADDED_EXERCISES} exercises are added to one session to reach a group’s range.`,
		'A session keeps its length and its focus, so a group still short goes to another day.'
	)
];

const runningNumbers: RuleDefinition[] = [
	constant(
		'running.commitment_rpe',
		`${R}#COMMITMENT_RPE`,
		running.COMMITMENT_RPE,
		`A commitment is planned at RPE ${rpeWhen(running.COMMITMENT_RPE)}, and moderate when you gave no intensity.`,
		'A class or club run has its own effort, so the week counts it at the effort you told.'
	),
	constant(
		'running.commitment_run',
		`${R}#COMMITMENT_RUN`,
		running.COMMITMENT_RUN,
		'A running commitment is one timed segment: an easy run in zone 2 when light, a steady run in zone 3 when moderate, a tempo run in zone 4 when hard.',
		'The club sets the pace, so the plan records only the effort, and a hard club run counts as a hard session.'
	),
	constant(
		'running.commitment_type',
		`${R}#COMMITMENT_TYPE`,
		running.COMMITMENT_TYPE,
		'Any other commitment is planned as its own class: a strength, powerlifting, weightlifting or hypertrophy class as a strength class, an athletic one as S&C, Muay Thai as Muay Thai, anything else as custom.',
		'A class’s content is its own, so the plan names it by what it trains and counts its load without writing its exercises.'
	),
	constant(
		'running.under_volume',
		`${R}#UNDER_VOLUME`,
		running.UNDER_VOLUME,
		`A week planned under ${pct(running.UNDER_VOLUME)} of its running volume says why in its run_volume decision.`,
		'A week well short of the volume you told should explain itself rather than look like a mistake.'
	),
	constant(
		'running.min_run',
		`${R}#MIN_RUN`,
		running.MIN_RUN,
		`No run is planned under ${running.MIN_RUN.metres / 1000} km, or ${running.MIN_RUN.minutes} minutes in a week by time: a week too small for its runs has fewer, all easy.`,
		'A shorter run costs a session for little training, so fewer, longer runs hold the week’s volume better.'
	),
	constant(
		'running.distance_step',
		`${R}#RUN_DISTANCE_STEP`,
		running.RUN_DISTANCE_STEP,
		`Distances are planned in whole steps of ${running.RUN_DISTANCE_STEP} metres, rounded down.`,
		'A round distance is easy to follow and to log, and rounding down never takes a week over its volume.'
	),
	constant(
		'running.time_based_week',
		`${R}#TIME_BASED_WEEK`,
		running.TIME_BASED_WEEK,
		`With no weekly running told, easy runs are ${running.TIME_BASED_WEEK.easyMinutes} minutes and the long run, for a runner who is not new, ${running.TIME_BASED_WEEK.longMinutes} minutes; later weeks scale both.`,
		'With no mileage to build from, short timed runs are a safe start at any fitness.'
	),
	constant(
		'running.assumed_easy_pace',
		`${R}#ASSUMED_EASY_PACE`,
		running.ASSUMED_EASY_PACE,
		`With no pace or race known, an easy pace of ${paceOf(running.ASSUMED_EASY_PACE)} per km estimates a distance run’s minutes. It is never a target.`,
		'A week still has to fit your session length, and a conservative easy pace keeps the estimate from running short.'
	),
	constant(
		'running.riegel_exponent',
		`${R}#RIEGEL_EXPONENT`,
		running.RIEGEL_EXPONENT,
		`A race at a distance VDOT does not read is carried to one it does by Riegel’s formula, with the exponent ${running.RIEGEL_EXPONENT}.`,
		'Riegel’s formula is the standard model of how pace slows with distance, so any race you told can set your paces.'
	),
	constant(
		'running.runs',
		`${R}#RUNS`,
		running.RUNS,
		`An easy run is planned at session RPE ${running.RUNS.easy_run.sessionRpe} and the long run at ${running.RUNS.long_run.sessionRpe}; tempo and interval runs take their quality session’s.`,
		'Most running should be easy, so it adds aerobic volume without taking recovery from the hard sessions.'
	),
	constant(
		'running.custom_session_rpe',
		`${R}#CUSTOM_SESSION_RPE`,
		running.CUSTOM_SESSION_RPE,
		`A custom-discipline goal with no commitment gets sessions of your session length at RPE ${running.CUSTOM_SESSION_RPE}.`,
		'Without knowing what the discipline trains, a moderate effort keeps the session useful without costing the rest of the week.'
	)
];

// ---- Added sessions -------------------------------------------------------------------------

const A = 'rules/added.ts';
/** The weeks a sparring session is planned in, as 'accumulation, … or peak'. */
const sparringWeeks = list(
	running.MUAY_THAI.sparringWeeks.map((kind) =>
		WEEK_KIND_LABEL[kind].replace(/ week$/, '').toLowerCase()
	),
	'or'
);
const addedRules: RuleDefinition[] = [
	constant(
		'added.strength_rpe',
		`${A}#STRENGTH_RPE`,
		added.STRENGTH_RPE,
		`A strength or hypertrophy session you add is planned at RPE ${rpeWhen(added.STRENGTH_RPE)}, before the week’s cap.`,
		'The intent you pick sets the effort, and the week’s cap still keeps a deload light.'
	),
	constant(
		'added.conditioning',
		`${A}#CONDITIONING`,
		added.CONDITIONING,
		`A conditioning session you add is ${added.CONDITIONING.minutes} minutes, or your session length if shorter, unless you give a length, at RPE ${rpeWhen(added.CONDITIONING.rpe)}.`,
		'A short session at the effort you pick adds conditioning without crowding the week.'
	),
	constant(
		'added.run_type',
		`${A}#RUN_TYPE`,
		added.RUN_TYPE,
		'A run you add is an easy run when easy, a tempo run when moderate and intervals when hard.',
		'Each intent maps to the run that trains at that effort, so an added run is a real session, not a guess.'
	),
	constant(
		'added.muay_thai_kind',
		`${A}#MUAY_THAI_KIND`,
		added.MUAY_THAI_KIND,
		`A Muay Thai session you add is technical when easy, pad work when moderate and sparring when hard, or pad work if you do no sparring or the week is not a sparring week (${sparringWeeks}).`,
		'The intent sets the format, and sparring is never planned for someone who does not spar.'
	)
];

// ---- Provenance the services record ----------------------------------------------------------

/** The decisions the program services add to a plan they store, by the function that adds them. */
const serviceRules: RuleDefinition[] = [
	{
		id: 'program.confirmed',
		kind: 'behaviour',
		statement:
			'A program is saved only when you or the coach confirm the plan shown, unchanged: the same profile, exercise library and start dates, recorded as the confirmation.',
		rationale:
			'Nothing changes your training without your say, and a plan that changed after you saw it is shown again rather than saved.',
		source: 'src/lib/server/services/programming/build.ts#buildProgram'
	},
	{
		id: 'program.start_moved',
		kind: 'behaviour',
		statement:
			'Moving a program’s start plans it again from the new date as a new version, recording who moved it, from when and to when.',
		rationale:
			'Every week is planned from its start date, so a moved start is planned again rather than shifted, and the history says why.',
		source: 'src/lib/server/services/programming/move.ts#moveProgramStart'
	}
];

export const rules: readonly RuleDefinition[] = [
	...days,
	...dayNumbers,
	...blocks,
	...strengthRules,
	...strengthNumbers,
	...selected,
	...volume,
	...volumeNumbers,
	...runningRules,
	...runningNumbers,
	...placement,
	...defaults,
	...exercises,
	...addedRules,
	...serviceRules
];
