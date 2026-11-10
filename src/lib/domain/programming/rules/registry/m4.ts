/**
 * M4's programming rules (m7/13 rules-registry-m4-m6): what 'This hurts' offers (rules/pain.ts,
 * applied by ../../pain.ts gentlerFor) and what each in-workout quick action does
 * (domain/workout/substitution.ts). Every entry is a constant reading its live export, so its
 * values never drift. M4's substitution and pain paths cite no rule key of their own (nothing
 * logs a programming decision mid-workout), so the area has no behaviour entries. Rationales are
 * the code's own: PAIN_RULES carries one beside each value, and the quick actions' come from
 * substitution.ts's doc comment.
 */
import { QUICK_ACTIONS } from '../../../workout/substitution.ts';
import type { QuickAction } from '../../../workout/substitution.ts';
import { GENTLER_WORDS, PAIN_RULES } from '../pain.ts';
import type { PainRules } from '../pain.ts';
import type { RuleDefinition } from './types.ts';

const PAIN = 'src/lib/domain/programming/rules/pain.ts';
const SUBSTITUTION = 'src/lib/domain/workout/substitution.ts';

/** Each PAIN_RULES key: its rule id and what it does, from its live value. */
const PAIN_STATEMENT: Record<keyof PainRules, [id: string, statement: string]> = {
	severity: [
		'pain.severity',
		`A sore area is treated as a ${PAIN_RULES.severity.value} injury: whatever M3's injury exclusions rule out for it up to that severity is never offered.`
	],
	noHarder: [
		'pain.no_harder',
		PAIN_RULES.noHarder.value
			? 'A gentler option is never harder to do than the exercise it replaces.'
			: 'A gentler option may be harder to do than the exercise it replaces.'
	],
	loadTags: [
		'pain.load_tags',
		`Options with fewer of the hardest-loading tags (${PAIN_RULES.loadTags.value.join(', ')}) rank first.`
	],
	supportedEquipment: [
		'pain.supported_equipment',
		`After load, options on guided equipment (${PAIN_RULES.supportedEquipment.value.join(', ')}) rank first.`
	],
	limit: [
		'pain.limit',
		`At most ${PAIN_RULES.limit.value} gentler options are offered per body area, best first.`
	]
};

const pain: RuleDefinition[] = (Object.keys(PAIN_STATEMENT) as (keyof PainRules)[]).map((key) => ({
	id: PAIN_STATEMENT[key][0],
	kind: 'constant',
	statement: PAIN_STATEMENT[key][1],
	rationale: PAIN_RULES[key].rationale,
	source: `${PAIN}#PAIN_RULES.${key}`,
	values: PAIN_RULES[key]
}));

/** Each quick action: what it does, and why. */
const ACTION: Record<QuickAction, [statement: string, rationale: string]> = {
	machine_unavailable: [
		'Machine unavailable swaps the exercise for today only, ranking first the alternatives that need none of its equipment; it writes no preference and leaves the program as it is.',
		'A busy or missing machine says nothing about the exercise: next time it may be free, so nothing lasting changes.'
	],
	suggest_alternative: [
		'Suggest an alternative offers the kit’s ranked alternatives as they are, for this session only.',
		'A one-off choice is the owner’s to make in the moment; it is not a dislike and changes nothing beyond today.'
	],
	dislike: [
		'I don’t like this exercise asks for confirmation, then records a lasting dislike, swaps it today and, when the slot performs its planned exercise, replaces it in the program from today.',
		'A dislike outlives the workout, so it is confirmed first; a disliked exercise is not prescribed again, so the program stops planning it.'
	],
	pain: [
		'This hurts records a pain report, never a preference: stopping the exercise comes first, then the gentler options for the chosen area, then ending the workout when it is severe.',
		'Pain is about today’s body, not the exercise, so it never becomes a dislike; stopping is always the first choice offered.'
	],
	skip: [
		'Skip exercise records a skipped set for each planned set not done yet, and nothing else.',
		'Skipped work is logged as skipped, never as done, so the review reads the session as it was.'
	]
};

const substitution: RuleDefinition[] = (Object.keys(ACTION) as QuickAction[]).map((action) => ({
	id: `substitution.${action}`,
	kind: 'constant',
	statement: ACTION[action][0],
	rationale: ACTION[action][1],
	source: `${SUBSTITUTION}#QUICK_ACTIONS.${action}`,
	values: QUICK_ACTIONS[action]
}));

export const rules: readonly RuleDefinition[] = [
	...pain,
	{
		id: 'pain.gentler_words',
		kind: 'constant',
		statement:
			'Each gentler option says what it is gentler by: simpler to do, less load and impact, or guided by a machine or cable.',
		rationale:
			'Why an option is offered reads at a glance, in the order the options are ranked by.',
		source: `${PAIN}#GENTLER_WORDS`,
		values: GENTLER_WORDS
	},
	...substitution
];
