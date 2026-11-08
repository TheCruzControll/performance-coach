/**
 * The evaluation rules (m7/03 week-evaluation): how evaluateWeek scores and grades a week, which
 * reason a kept finding gives, and when the owner can still act on one.
 */
import { GRADES, RESOLUTION_ORDER, SCORE_WEIGHTS } from '../evaluation.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/rules/evaluation.ts';

export const rules: readonly RuleDefinition[] = [
	{
		id: 'evaluation.score_weights',
		kind: 'constant',
		statement:
			'A week starts at 100. Each avoid finding costs 25 and each prefer finding 8, at half that when the plan explains why it keeps it.',
		rationale:
			'Four unexplained avoid findings leave nothing, because each risks injury or a session done badly; advice costs little; a kept trade-off still tires the body, so it still costs.',
		source: `${FILE}#SCORE_WEIGHTS`,
		values: SCORE_WEIGHTS
	},
	{
		id: 'evaluation.grades',
		kind: 'constant',
		statement:
			'A week is clear with nothing ahead to act on, minor when what is ahead is advice or explained, and has conflicts when an unexplained avoid finding is still ahead.',
		rationale:
			'Days already past cannot change, so the grade speaks only of what the owner can still act on.',
		source: `${FILE}#GRADES`,
		values: GRADES
	},
	{
		id: 'evaluation.resolution_order',
		kind: 'constant',
		statement:
			'A kept finding gives one reason, the first that applies: your own move, fixed commitments, a goal’s priority, then no free day.',
		rationale:
			'Your own choice says most about why the week looks this way; a commitment cannot move; the rest are the plan’s own trade-offs.',
		source: `${FILE}#RESOLUTION_ORDER`,
		values: RESOLUTION_ORDER
	},
	{
		id: 'evaluation.actionable',
		kind: 'behaviour',
		statement:
			'A finding is actionable while its later session is today or still ahead; skipped sessions are not judged.',
		rationale:
			'A move or an easier session can still fix it; once its days have passed it is history, not advice.',
		source: 'src/lib/domain/programming/evaluate/week.ts#evaluateWeek'
	}
];
