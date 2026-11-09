/**
 * The fatigue rules (m7/15 load-fatigue): how fast each body system recovers, how its
 * acute:chronic ratio and residual fatigue are judged, what they are judged against, and how
 * planned and logged sessions combine into one load.
 */
import { HALF_LIVES, HISTORY, RATIO, RESIDUAL } from '../fatigue.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/rules/fatigue.ts';

export const rules: readonly RuleDefinition[] = [
	{
		id: 'fatigue.half_lives',
		kind: 'constant',
		statement:
			'Each system’s leftover fatigue halves over its own half-life: legs 2.5 days, upper body, combat and the nervous system 2, aerobic 1.5.',
		rationale:
			'Systems recover at different speeds, so a hard leg day still counts two days later when an easy run is long forgotten.',
		source: `${FILE}#HALF_LIVES`,
		values: HALF_LIVES
	},
	{
		id: 'fatigue.ratio',
		kind: 'constant',
		statement:
			'Each system’s acute:chronic ratio is the one Progress shows (7- and 28-day averages), from 28 days of history. While a system still carries a hard session’s fatigue, 1.3 makes it at least elevated and 1.5 one level worse.',
		rationale:
			'A fast rise in load is a warning only while that load is still with you: one session a week spikes the ratio every week without any rise.',
		source: `${FILE}#RATIO`,
		values: RATIO
	},
	{
		id: 'fatigue.residual',
		kind: 'constant',
		statement:
			'A system is elevated when its leftover fatigue is above 1.2 × its typical hard session, and overloaded above 1.75 ×.',
		rationale:
			'One hard session leaves about 1 ×; more means fatigue is stacking, and a steady week peaks near 1.5 ×, so overload starts above it.',
		source: `${FILE}#RESIDUAL`,
		values: RESIDUAL
	},
	{
		id: 'fatigue.history',
		kind: 'constant',
		statement:
			'A system’s typical hard session is the median of its hardest session each week: from the plan until there are 28 days of history, then from the last 28 days of logs.',
		rationale:
			'Fatigue is judged against your own training, so the same day reads the same for a beginner and an athlete.',
		source: `${FILE}#HISTORY`,
		values: HISTORY
	},
	{
		id: 'fatigue.model',
		kind: 'behaviour',
		statement:
			'Logged sessions replace planned ones up to today: a completed session counts once, a skipped one never, and one never logged counts 0 and is named missed. Estimated load is its own series, never in a logged total.',
		rationale:
			'The model reads what you actually did and what is still ahead, so Train, the coach and the weekly review agree with Progress.',
		source: 'src/lib/domain/programming/load/fatigue.ts#loadModel'
	}
];
