/**
 * The schedule rules (m7/21 week-scheduler): how repairWeek turns a week's findings into a better
 * week. The ids are the rule keys its decisions cite, besides the finding's own rule, which a move
 * or an ease cites.
 */
import { ACTIONS, BOUNDS, EASE, FIXED, KEPT, OBJECTIVE, TIME_RULES } from '../schedule.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/rules/schedule.ts';

export const rules: readonly RuleDefinition[] = [
	{
		id: 'schedule.actions',
		kind: 'constant',
		statement:
			'To fix a finding, a session first moves to another free day of its week, then swaps days with another session, then changes its time of day, then is eased, and only as a last resort is left out.',
		rationale:
			'Each step loses more of the week’s work than the one before, so the cheapest fix that works is the one taken.',
		source: `${FILE}#ACTIONS`,
		values: ACTIONS
	},
	{
		id: 'schedule.time_rules',
		kind: 'constant',
		statement:
			'A time-of-day change is tried only for the same-day order and the gap between two sessions on one day.',
		rationale: 'The clock changes nothing about the day before or the day after.',
		source: `${FILE}#TIME_RULES`,
		values: TIME_RULES
	},
	{
		id: 'schedule.objective',
		kind: 'constant',
		statement:
			'A week costs 1,000 per avoid finding times one plus the losing goal’s weight, 10 per prefer finding, a little for peaks of hard load, 0.1 per day a session moves, 50 per eased session, 500 per session left out, and 20 for a long run on a weekday.',
		rationale:
			'Rules that protect you come first and the leading goal is protected most; then advice and load peaks; then the week stays as close as it can to the days it was given.',
		source: `${FILE}#OBJECTIVE`,
		values: OBJECTIVE
	},
	{
		id: 'schedule.bounds',
		kind: 'constant',
		statement: 'The search makes at most 4 passes over the findings and judges at most 400 weeks.',
		rationale:
			'A week is repaired in a known, short time; whatever is left is kept and explained, never hidden.',
		source: `${FILE}#BOUNDS`,
		values: BOUNDS
	},
	{
		id: 'schedule.fixed',
		kind: 'constant',
		statement:
			'Commitments, sessions already past, completed or skipped, and your own moves never change, unless a suggestion to you may move your own moves.',
		rationale: 'The scheduler plans around what is settled instead of rewriting it.',
		source: `${FILE}#FIXED`,
		values: FIXED
	},
	{
		id: 'schedule.kept',
		kind: 'constant',
		statement:
			'Every change keeps M3’s day rule and doubles, the weekend long run, and each session in its own week.',
		rationale: 'A repaired week is still a week the generator could have planned.',
		source: `${FILE}#KEPT`,
		values: KEPT
	},
	{
		id: 'schedule.ease',
		kind: 'constant',
		statement:
			'An eased session is moderate instead of hard, its lower-body sets and its own target are capped at RPE 7, and sparring becomes pad work.',
		rationale:
			'It keeps the session and most of its stimulus while removing what made the clash risky.',
		source: `${FILE}#EASE`,
		values: EASE
	},
	{
		id: 'schedule.drop',
		kind: 'behaviour',
		statement:
			'A generated session is left out only for an avoid finding nothing cheaper fixes, and only when its goal ranks below every goal the finding names.',
		rationale: 'Lower-priority sessions give way first, and a higher-priority one is never lost.',
		source: 'src/lib/domain/programming/schedule/repair.ts#repairWeek'
	},
	{
		id: 'schedule.priority_kept',
		kind: 'behaviour',
		statement:
			'A clash the week keeps because a higher-priority goal’s session holds its day is recorded with a sentence naming both goals.',
		rationale: 'A trade-off is the owner’s to know about, never hidden.',
		source: 'src/lib/domain/programming/schedule/repair.ts#repairWeek'
	}
];
