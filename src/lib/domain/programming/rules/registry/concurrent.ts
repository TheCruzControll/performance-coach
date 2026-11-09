/**
 * The concurrent rules (m7/20 concurrent-load-rules): the PRD §2 and §5 rules the load model and
 * goal priorities make possible, judged by evaluateWeek beside M3's. Each rule's id is the key its
 * findings carry; the thresholds are listed with their live values.
 */
import {
	CNS_SESSIONS_MAX,
	CONCURRENT_RULES,
	EVENT_LEAD_DAYS,
	HARD_DAYS_CAP,
	INTERFERES_WITH,
	LIMITED_WEEKS,
	RUN_LOAD_HIGH,
	SEPARATION_HOURS,
	SLOT_HOURS,
	SPARRING_MAX
} from '../concurrent.ts';
import type { ConcurrentRule } from '../concurrent.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/rules/concurrent.ts';

const STATEMENTS: Readonly<Record<ConcurrentRule, string>> = {
	residual_fatigue_before_hard:
		'No hard session while a body system it needs is overloaded by the fatigue earlier days left.',
	three_hard_days:
		'No three hard days in a row, unless every session in them is a fixed commitment.',
	hard_days_cap: 'No more hard days a week than your experience recovers from.',
	weekly_cns_cap:
		'At most three sessions a week of heavy lifting, intervals or sparring, which tax the nervous system.',
	run_volume_vs_leg_strength:
		'In a high-running week, lower-body hard sets stay within the maintenance dose.',
	same_day_priority_order:
		'With goal priorities known, when one day holds two hard sessions the higher-priority goal’s session goes first.',
	same_day_separation:
		'Two hard sessions on one day sit at least six hours apart; a hard and a moderate one should too.',
	event_protection:
		'No heavy lower body within 5 days of a race, no sparring within 7 of a fight, and nothing above openers within 4 of a meet.',
	recovery_week_limits:
		'A deload, taper, recovery or maintenance week holds every session to its RPE cap; a cutback week holds only its running minutes.',
	sparring_cap: 'At most two hard sparring sessions a week.'
};

const checks = (Object.keys(CONCURRENT_RULES) as ConcurrentRule[]).map((rule): RuleDefinition => ({
	id: `concurrent.${rule}`,
	kind: 'constant',
	statement: STATEMENTS[rule],
	rationale: CONCURRENT_RULES[rule].why,
	severity: CONCURRENT_RULES[rule].severity,
	source: `${FILE}#CONCURRENT_RULES.${rule}`,
	values: CONCURRENT_RULES[rule]
}));

export const rules: readonly RuleDefinition[] = [
	...checks,
	{
		id: 'concurrent.slot_hours',
		kind: 'constant',
		statement:
			'A session’s time of day stands for a clock hour: early morning 5, morning 7, midday 12, afternoon 16 and evening 19.',
		rationale:
			'The gap between two sessions on one day is judged in hours; a session at no set time is never judged on it.',
		source: `${FILE}#SLOT_HOURS`,
		values: SLOT_HOURS
	},
	{
		id: 'concurrent.separation_hours',
		kind: 'constant',
		statement: 'Two hard sessions on one day need six hours between them.',
		rationale:
			'About what the legs and the nervous system need to give the second session a fair start.',
		source: `${FILE}#SEPARATION_HOURS`,
		values: SEPARATION_HOURS
	},
	{
		id: 'concurrent.hard_days_by_experience',
		kind: 'constant',
		statement:
			'The most hard days a week: 2 for a new athlete, 3 for a novice, 4 intermediate and 5 advanced.',
		rationale: 'Recovery grows with training age, so the cap does too.',
		source: `${FILE}#HARD_DAYS_CAP`,
		values: HARD_DAYS_CAP
	},
	{
		id: 'concurrent.cns_sessions_max',
		kind: 'constant',
		statement: 'At most three sessions a week of heavy lifting, intervals or sparring.',
		rationale: 'The nervous system recovers slowly when near-maximal efforts pile up.',
		source: `${FILE}#CNS_SESSIONS_MAX`,
		values: CNS_SESSIONS_MAX
	},
	{
		id: 'concurrent.sparring_max',
		kind: 'constant',
		statement: 'At most two hard sparring sessions a week.',
		rationale: 'Fight camp’s cap: hard sparring is the most damaging Muay Thai session.',
		source: `${FILE}#SPARRING_MAX`,
		values: SPARRING_MAX
	},
	{
		id: 'concurrent.run_load_high',
		kind: 'constant',
		statement:
			'A week’s running is high at an aerobic acute:chronic ratio of 1.3 or more, or in any marathon or half marathon build or peak week; leg lifting is then held to M3’s maintenance band.',
		rationale:
			'The ratio needs 28 days of history, so a build or peak week counts as high whatever the history.',
		source: `${FILE}#RUN_LOAD_HIGH`,
		values: RUN_LOAD_HIGH
	},
	{
		id: 'concurrent.event_lead_days',
		kind: 'constant',
		statement:
			'Heavy lower body at least 5 days before a race, sparring at least 7 before a fight, nothing above openers (RPE 8, 90 % of a 1RM) within 4 of a meet.',
		rationale: 'The days before an event are for arriving fresh and sharp.',
		source: `${FILE}#EVENT_LEAD_DAYS`,
		values: EVENT_LEAD_DAYS
	},
	{
		id: 'concurrent.limited_weeks',
		kind: 'constant',
		statement:
			'The RPE cap of a light week when its own targets are not given: M3’s deload and taper caps, 6 in a recovery week and 8 in a maintenance week.',
		rationale:
			'A light week is light on purpose, so its fatigue clears; maintenance caps the main lifts’ top set at RPE 8.',
		source: `${FILE}#LIMITED_WEEKS`,
		values: LIMITED_WEEKS
	},
	{
		id: 'concurrent.interferes_with',
		kind: 'constant',
		statement:
			'Which systems’ fatigue matters before each hard session: legs and nervous system before heavy legs, legs, aerobic and nervous system before intervals, legs and aerobic before a long run, combat, legs and nervous system before hard Muay Thai, upper body and nervous system before heavy upper body.',
		rationale: 'A session suffers from the fatigue of the systems it uses, and only those.',
		source: `${FILE}#INTERFERES_WITH`,
		values: INTERFERES_WITH
	},
	{
		id: 'concurrent.goal_weighted_costs',
		kind: 'behaviour',
		statement:
			'With priorities, each finding costs its severity times the harmed goal’s weight, and a clash kept for a higher-ranked goal says so in a sentence naming both goals.',
		rationale: 'The leader’s sessions are protected first; a low-ranked goal gives way.',
		source: 'src/lib/domain/programming/evaluate/concurrent.ts#weightFor'
	}
];
