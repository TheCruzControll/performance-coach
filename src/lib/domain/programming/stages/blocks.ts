/**
 * The blocks the plan holds, from week 1's Monday: the skeleton every later stage fills. M6's next
 * block replaces this stage with nextShape.
 * - With a season (prepare's Draft.periodisation), its blocks: the first planned with its weeks
 *   and targets, then the outlines, each event's run-up ending on its Sunday. Its decisions are
 *   recorded here (block_structure, block_type_chosen, taper_planned, M3's event_taper where M3's
 *   first block is kept, and the ramps), but not the first block's priority_resolved, which
 *   prepare records; then a deload_scheduled for each deload the season planned in the first
 *   block, and the M3 decisions planSeason leaves to the generator (default_assumed, goal_excluded).
 * - With every goal paused, M3's maintenance plan (planFirstBlock), unchanged.
 * - Without a season, M3's first block and outline (../blocks.ts), as before M7.
 * Either way, every goal held at maintenance in the first block gets one maintenance_dose decision
 * per stream it trains. BlockPlan.progression holds only numbers, so each maintenance_dose names
 * its goal's ref and mode in its evidence.
 */
import { planFirstBlock } from '../blocks.ts';
import type { DecisionLog, FactsFor } from '../decisions.ts';
import { clip } from '../demand.ts';
import type { ProgrammingInput } from '../input.ts';
import { toBlockPlans } from '../periodisation/season.ts';
import type { BlockSkeleton } from '../periodisation/season.ts';
import { assumptionFacts } from '../rules/defaults.ts';
import type { Periodisation, Stage } from '../stage.ts';

/** The rule key a scheduled deload of the season cites (registry/deload.ts). */
export const SCHEDULED_DELOAD_KEY = 'deload.scheduled';

/** Why a deload of the season's first block sits where it does: a whole sentence. */
export const SCHEDULED_DELOAD_WHY =
	'It follows the deload cadence for your experience, so the weeks of work before it sink in.';

/**
 * One maintenance_dose per goal and stream held in the first block's weeks, in week order. M6's
 * next block, which replaces this stage, records its own doses with it.
 */
export function recordDoses({ dosesByWeek }: Periodisation, log: DecisionLog) {
	const seen = new Set<string>();
	for (const { doses } of dosesByWeek) {
		for (const d of doses) {
			const key = `${d.goal.id}:${d.stream}`;
			if (seen.has(key)) continue;
			seen.add(key);
			log.add('maintenance_dose', `maintenance.${d.stream}`, ['blocks.0'], {
				goal: clip(d.goal.title, 60),
				leader: d.leader ? clip(d.leader.title, 60) : 'no other goal',
				dose: clip(d.dose.words, 200),
				reason: clip(d.reason, 200),
				stream: d.stream,
				goalRef: d.goal.id,
				mode: 'maintenance'
			});
		}
	}
}

/** A deload_scheduled for each deload week the season planned in an M7 first block. */
function recordDeloads(first: BlockSkeleton, log: DecisionLog) {
	if (first.type === null) return;
	for (const [i, week] of first.weeks.entries()) {
		if (week.kind !== 'deload') continue;
		log.add('deload_scheduled', SCHEDULED_DELOAD_KEY, [`blocks.0.weeks.${i}`], {
			week: i + 1,
			rpeCap: week.targets.rpeCap,
			reason: SCHEDULED_DELOAD_WHY
		});
	}
}

/** M3's decisions about the input itself, which planFirstBlock writes and planSeason leaves out. */
function recordInputs(input: ProgrammingInput, log: DecisionLog) {
	for (const assumption of input.assumptions) {
		log.add('default_assumed', assumption.ruleKey, [], assumptionFacts(assumption, input));
	}
	for (const goal of input.paused) {
		log.add('goal_excluded', 'goals.paused', [], { goal: clip(goal.title, 80) });
	}
}

export const blocks: Stage = (draft, { input, options, log }) => {
	const periodisation = draft.periodisation;
	if (!periodisation || input.maintenance) {
		const planned = planFirstBlock(input, options.startsOn, log);
		if (periodisation) recordDoses(periodisation, log);
		return { ...draft, blocks: planned };
	}
	const { season } = periodisation;
	for (const d of season.decisions) {
		if (d.kind === 'maintenance_dose') continue;
		if (d.kind === 'priority_resolved' && d.refs.includes('blocks.0')) continue;
		log.add(d.kind, d.ruleKey, d.refs, d.evidence as FactsFor<typeof d.kind>);
	}
	recordDoses(periodisation, log);
	recordDeloads(season.blocks[0]!, log);
	recordInputs(input, log);
	return { ...draft, blocks: toBlockPlans(season.blocks) };
};
