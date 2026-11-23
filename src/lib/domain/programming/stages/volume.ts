/**
 * Weekly hard sets per muscle group inside the goal’s range (../volume.ts), for the split the
 * strength stage chose: every block with weeks at full volume is balanced, the outline is not.
 * Runs after placement and phasing, and before loads, progression and timefit, which checks every
 * set again.
 *
 * M7 (generator-phasing): a week's hard-set band is
 * - its own setsPerGroup [min, max] when it carries one (a hypertrophy week's rising range, a
 *   dosed week's band), within the session length. Weeks that share a range are balanced
 *   together; a block whose range rises is balanced range by range, the light weeks with the
 *   first, so every week sits in its own range and a deload takes the first week's sessions.
 * - otherwise doseBand(split, phase, mode), for the mode prepare gave the strength goal: the
 *   maintenance split's band at maintenance, the lower half of its style's band when secondary,
 *   and M3's hardSetBand unchanged when it leads or no mode is set.
 * A block keeps one volume_adjusted decision per group, across its ranges.
 */
import type {
	BlockPlan,
	PlanPath,
	SessionPlan,
	StrengthSessionPlan,
	WeekPlan
} from '../../training/types.ts';
import { DecisionLog } from '../decisions.ts';
import type { FactsFor } from '../decisions.ts';
import type { ProgrammingInput } from '../input.ts';
import { doseBand } from '../priority/doses.ts';
import { WORKING_RPE } from '../rules/strength.ts';
import { VOLUME_WEEK_MIN } from '../rules/volume.ts';
import { demandIn } from '../stage.ts';
import type { Stage } from '../stage.ts';
import { chooseSplit } from '../splits.ts';
import type { Split } from '../splits.ts';
import { balanceBlock, hardSetBand } from '../volume.ts';
import type { SetBand } from '../volume.ts';
import { strengthMode } from './phasing.ts';

type Range = NonNullable<WeekPlan['targets']['setsPerGroup']>;

const span = (lo: number, hi: number) => (lo === hi ? `${lo}` : `${lo}–${hi}`);

/** The band for weeks with no setsPerGroup: doseBand's, for the strength goal's mode. */
export function heldBand(split: Split, input: ProgrammingInput): SetBand {
	const mode = strengthMode(input) ?? 'primary';
	const phase = input.nutritionPhase;
	const { keep, toward, band } = hardSetBand(
		{ ...split, maintenance: split.maintenance || mode === 'maintenance' },
		phase
	);
	const sets = doseBand(split, phase, mode);
	return {
		sets,
		keep,
		toward,
		band: mode === 'secondary' ? halfWords(split, sets, keep, toward) : band,
		trim: mode !== 'primary'
	};
}

/**
 * A secondary goal's band in words, as the balance aims at it: the lower half `sets` of its own
 * style's band, `keep` of it on a cut and its top on a bulk (`toward`).
 */
function halfWords(split: Split, sets: readonly [number, number], keep: number, toward: number) {
	const { band } = hardSetBand({ ...split, maintenance: false }, null);
	const half = (n: number) => Math.round(n * 2) / 2;
	const cut = keep < 1 ? `${span(half(keep * sets[0]), half(keep * sets[1]))} on a cut, from ` : '';
	return `${cut}${toward > 0 ? 'the top of ' : ''}${span(...sets)}, the lower half of ${band}`;
}

/**
 * The band of weeks that carry `range`, as it stands: in `held`'s words when the block plans only
 * that band (a dosed week's) and no nutrition phase moves `held`, otherwise in words naming the
 * block's range.
 */
function rangeBand({ min, max }: Range, first: Range, last: Range, held: SetBand): SetBand {
	const one = first.min === last.min && first.max === last.max;
	const same = min === held.sets[0] && max === held.sets[1] && held.keep === 1 && !held.toward;
	const band =
		one && same
			? held.band
			: one
				? `the ${span(min, max)} the block plans each week`
				: `each week’s range, from ${span(first.min, first.max)} in its first to ${span(last.min, last.max)} in its last`;
	return { sets: [min, max], keep: 1, toward: 0, band };
}

/** The [lo, hi] a volume_adjusted decision's `sets` words name ('10–12' or '10'). */
const rangeOf = (sets: string) => {
	const [lo, hi = lo] = sets.split('–').map(Number);
	return [lo!, hi!] as const;
};

/** Why a group goes over its range in some of the block's weeks but not in all of them. */
export const OVER_IN_SOME =
	" Its main lifts' back-off sets, and work it shares with other groups, take it over in some weeks.";

/**
 * The decisions of `logs` (one per range) in `log`: one volume_adjusted per group, its sets
 * spanning every range it was changed in, with the first reason, and why it goes over: as said
 * when it does in every range, OVER_IN_SOME when only in some; any other decision once per rule.
 */
function merge(logs: readonly DecisionLog[], log: DecisionLog) {
	type Facts = FactsFor<'volume_adjusted'>;
	const groups = new Map<
		string,
		{ ruleKey: string; refs: PlanPath[]; facts: Facts; over: number }
	>();
	const others = new Set<string>();
	for (const d of logs.flatMap((l) => l.list())) {
		if (d.kind !== 'volume_adjusted') {
			if (!others.has(d.ruleKey)) log.add(d.kind, d.ruleKey, d.refs, d.evidence as never);
			others.add(d.ruleKey);
			continue;
		}
		const facts = d.evidence as Facts;
		const over = facts.over ? 1 : 0;
		const seen = groups.get(String(facts.group));
		if (!seen) {
			groups.set(String(facts.group), { ruleKey: d.ruleKey, refs: d.refs, facts, over });
			continue;
		}
		const [a, b] = [rangeOf(String(seen.facts.sets)), rangeOf(String(facts.sets))];
		seen.over += over;
		seen.facts = {
			...seen.facts,
			sets: span(Math.min(a[0], b[0]), Math.max(a[1], b[1])),
			reason: seen.facts.reason || facts.reason,
			over: seen.facts.over || facts.over
		};
	}
	for (const { ruleKey, refs, facts, over } of groups.values()) {
		const some = over > 0 && over < logs.length;
		log.add('volume_adjusted', ruleKey, refs, some ? { ...facts, over: OVER_IN_SOME } : facts);
	}
}

const isStrength = (s: SessionPlan): s is StrengthSessionPlan =>
	s.kind === 'strength' && s.source === 'generator';

/**
 * `week`'s strength sessions built on `before`'s, balanced already: every line beside the main
 * lifts keeps its sets, and the exercises added to it stay, at `week`'s RPE; the main lifts are
 * `week`'s own. So a rising range only adds to the week before.
 */
function carried(week: WeekPlan, before: WeekPlan | null): WeekPlan {
	if (!before) return week;
	const rpe = Math.min(WORKING_RPE, week.targets.rpeCap);
	const sessions = week.sessions.map((s) => {
		const from = before.sessions.find((x) => isStrength(x) && x.title === s.title);
		if (!isStrength(s) || !from || !isStrength(from)) return s;
		const exercises = from.exercises.map((e, i) => {
			const own = s.exercises[i];
			if (own?.sets.some((line) => line.role === 'top')) return own;
			const base = own ?? { ...e, sets: e.sets.map((line) => ({ ...line, targetRpe: rpe })) };
			return { ...base, sets: base.sets.map((line, j) => ({ ...line, sets: e.sets[j]!.sets })) };
		});
		return { ...s, exercises };
	});
	return { ...week, sessions };
}

/**
 * Block `b` balanced range by range when its weeks carry setsPerGroup; as M3 balances it, to
 * `held`, otherwise.
 */
export function balancePhased(
	block: BlockPlan,
	b: number,
	split: Split,
	input: ProgrammingInput,
	log: DecisionLog,
	held: SetBand
): BlockPlan {
	const ranged = (w: WeekPlan) =>
		w.targets.setsPerGroup !== undefined && w.targets.volumeFactor >= VOLUME_WEEK_MIN;
	const key = ({ min, max }: Range) => `${min}–${max}`;
	const ranges = new Map(block.weeks.filter(ranged).map((w) => [key(w.targets.setsPerGroup!), w]));
	if (!ranges.size) return balanceBlock(block, b, split, input, log, held);
	const distinct = [...ranges.values()].map((w) => w.targets.setsPerGroup!);
	const [first, last] = [distinct[0]!, distinct.at(-1)!];
	const weeks = [...block.weeks];
	let before: WeekPlan | null = null;
	const logs = distinct.map((range, i) => {
		const own = new DecisionLog();
		const at = block.weeks.flatMap((w, j) =>
			(ranged(w) ? key(w.targets.setsPerGroup!) === key(range) : i === 0) ? [j] : []
		);
		const part = { ...block, weeks: at.map((j) => carried(block.weeks[j]!, before)) };
		const band = rangeBand(range, first, last, held);
		balanceBlock(part, b, split, input, own, band).weeks.forEach((w, k) => (weeks[at[k]!] = w));
		before = weeks[at.findLast((j) => ranged(block.weeks[j]!))!]!;
		return own;
	});
	merge(logs, log);
	return { ...block, weeks };
}

export const volume: Stage = (draft, { input, log }) => {
	const share = demandIn(draft).allocation.streams.find((s) => s.stream === 'strength');
	if (!share?.generated) return draft;
	const split = chooseSplit(input, share.generated);
	const held = heldBand(split, input);
	return {
		...draft,
		blocks: draft.blocks.map((block, b) => balancePhased(block, b, split, input, log, held))
	};
};
