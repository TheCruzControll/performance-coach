/**
 * Weekly hard sets per muscle group (PRD §5): a block's strength sessions adjusted so that each
 * major group's hard sets sit in the goal's range (rules/volume.ts), pulling keeps up with
 * pushing and the nutrition phase moves the range, all within the session length.
 *
 * - Hard sets are plannedHardSets' (training/metrics.ts), counted in every full-volume week as
 *   progression's withVolume and then the timefit stage will leave it: a week above full volume
 *   with its extra back-off sets, and a session over its length as fitSession trims it.
 *   A group's floor holds in its lightest week and its ceiling in its heaviest, since back-off
 *   sets turn hard once a week's RPE cap is 8. A week above full volume (an overreach week) has
 *   its ceiling scaled by its volume factor, as the deload's and taper's sets scale by theirs.
 * - One set at a time, it makes the change that brings the weeks closest to their targets: a set
 *   more or fewer on any line but a top set, or an exercise added through selection's
 *   plannedExercise from the eligible candidates (eligibility.ts), so equipment, injuries and
 *   dislikes still hold. A set is added only while estimateMinutes stays within sessionMinutes;
 *   one may come off any session. A main lift keeps its sets: loads and progression set them.
 *   Ties go to taking a set off, then to accessories, then to the session with most time to spare.
 * - A cut first plans the goal's sets, then only takes sets off, a main lift's back-offs among
 *   them, toward four fifths of each group's lightest and heaviest weeks; RPEs never change.
 * - A session changes alike in every week of the block, so weeks differ only by their own
 *   targets, which progression applies after.
 * - Each major group changed gets a volume_adjusted decision, and pulling one when it had to
 *   catch up; what stays short because no more fits the time gets one priority_tradeoff.
 *
 * Pure and deterministic.
 */
import {
	isHardSet,
	NON_WORKING_ROLES,
	plannedHardSets,
	sessionLoadOf
} from '../training/metrics.ts';
import type {
	BlockPlan,
	PlannedExercisePlan,
	SessionPlan,
	StrengthSessionPlan,
	WeekPlan
} from '../training/types.ts';
import { MUSCLE_GROUP, MUSCLE_GROUP_LABEL } from '../training/vocabulary.ts';
import type { DecisionLog } from './decisions.ts';
import { clip } from './demand.ts';
import { candidates, libraryOf } from './eligibility.ts';
import { toExerciseKey } from './input.ts';
import type { ExerciseKey, ProgrammingInput } from './input.ts';
import { GENERAL_STYLE, isAccessory, STYLE_OF } from './rules/strength.ts';
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
} from './rules/volume.ts';
import type { MajorGroup } from './rules/volume.ts';
import { withVolume } from './progression.ts';
import { LOAD_RULES } from './rules/loads.ts';
import { exerciseOf, listing, plannedExercise } from './selection.ts';
import type { Selected } from './selection.ts';
import type { Split } from './splits.ts';
import { estimateMinutes, fitSession, fitWeek } from './timefit.ts';

const GROUPS = Object.keys(MAJOR_GROUPS) as MajorGroup[];

/**
 * Why a group stays over its range: only in a week above full volume, whose volume factor scales
 * its ceiling; in its heaviest weeks; or in every week as well.
 */
const OVER = {
	overreach:
		' The heaviest week gives each main lift a back-off set more, so it goes over by design.',
	heaviest: " Its main lifts' back-off sets count as hard in the heaviest weeks, so those go over.",
	pulling: ' Pulling keeps level with pushing, so it goes over every week.',
	every: ' Its main lifts, and work it shares with other groups, keep it over every week.'
};

/** One week's count: hard sets per major group, and pushing and pulling sets. */
interface Tally {
	groups: Record<MajorGroup, number>;
	push: number;
	pull: number;
}

type Targets = Record<MajorGroup, { floor: number; ceiling: number }>;

/** What changes in one of the block's sessions, in every week: added exercises, then sets. */
interface Edit {
	added: Selected[];
	/** Sets more or fewer on the line at 'exercise.line'; an added exercise starts at one set. */
	sets: Map<string, number>;
}

/** A set more (by 1) or fewer (by −1) on the line `at`, or an added exercise. */
interface Move {
	title: string;
	at: readonly [exercise: number, line: number] | null;
	add: Selected | null;
	by: 1 | -1;
	name: string;
}

const isStrength = (s: SessionPlan): s is StrengthSessionPlan =>
	s.kind === 'strength' && s.source === 'generator';

const plus = (a: Tally, b: Tally, by = 1): Tally => ({
	groups: Object.fromEntries(
		GROUPS.map((g) => [g, a.groups[g] + by * b.groups[g]])
	) as Tally['groups'],
	push: a.push + by * b.push,
	pull: a.pull + by * b.pull
});

/** The least and the most of `count` over the weeks. */
const spread = (tallies: readonly Tally[], count: (t: Tally) => number): [number, number] => {
	const counts = tallies.map(count);
	return [Math.min(...counts), Math.max(...counts)];
};
/**
 * The most of a group's hard sets in any week, in full-volume terms: each week's count over its
 * volume factor (`scales`), so an overreach week's extra back-off sets do not count against the
 * ceiling.
 */
const peak = (tallies: readonly Tally[], g: MajorGroup, scales: readonly number[]) =>
	Math.max(...tallies.map((t, w) => t.groups[g] / scales[w]!));
const words = ([lo, hi]: readonly [number, number]) => (lo === hi ? `${lo}` : `${lo}–${hi}`);
const pullsBehind = (t: Tally) => t.push * PULL_PER_PUSH > t.pull;

/**
 * How far the weeks are from their targets, in hard sets: first what is short of a floor or of
 * pulling as much as pushing, then what is over a ceiling. A floor is never given up for a ceiling.
 * A pulling set short weighs the same as a set short of a floor, so neither gives way to the other.
 */
function distance(
	tallies: readonly Tally[],
	targets: Targets,
	scales: readonly number[]
): [under: number, over: number] {
	let under = Math.max(0, ...tallies.map((t) => t.push * PULL_PER_PUSH - t.pull));
	let over = 0;
	for (const g of GROUPS) {
		under += Math.max(0, targets[g].floor - spread(tallies, (t) => t.groups[g])[0]);
		over += Math.max(0, peak(tallies, g, scales) - targets[g].ceiling);
	}
	return [under, over];
}

const EPSILON = 1e-9;
const closer = ([u, o]: readonly number[], [bu, bo]: readonly number[]) =>
	u! < bu! - EPSILON || (Math.abs(u! - bu!) <= EPSILON && o! < bo! - EPSILON);

/** `session` with `edit`, at `rpeCap`, its minutes and load estimated again. */
function withEdit(
	session: StrengthSessionPlan,
	edit: Edit,
	split: Split,
	rpeCap: number,
	input: ProgrammingInput
): StrengthSessionPlan {
	const added = edit.added.map((s) => {
		const planned = plannedExercise(s, split, rpeCap);
		return { ...planned, sets: planned.sets.map((line) => ({ ...line, sets: 1 })) };
	});
	const exercises = [...session.exercises, ...added].map((e, i) => ({
		...e,
		sets: e.sets.map((line, j) => ({
			...line,
			sets: line.sets + (edit.sets.get(`${i}.${j}`) ?? 0)
		}))
	}));
	const estMinutes = estimateMinutes({ exercises }, input);
	return { ...session, exercises, estMinutes, estLoad: sessionLoadOf({ ...session, estMinutes }) };
}

const moved = ({ added, sets }: Edit, { at, add, by }: Move): Edit => {
	const key = at && `${at[0]}.${at[1]}`;
	return {
		added: add ? [...added, add] : added,
		sets: key ? new Map(sets).set(key, (sets.get(key) ?? 0) + by) : sets
	};
};

/** Block `b`'s strength sessions balanced; the block as it is when no week is at full volume. */
export function balanceBlock(
	block: BlockPlan,
	b: number,
	split: Split,
	input: ProgrammingInput,
	log: DecisionLog
): BlockPlan {
	const titles = [
		...new Set(block.weeks.flatMap((w) => w.sessions.filter(isStrength).map((s) => s.title)))
	];
	const sessionOf = (week: WeekPlan, title: string) =>
		week.sessions.find((s): s is StrengthSessionPlan => isStrength(s) && s.title === title);
	const weeks = block.weeks.filter(
		(w) => w.targets.volumeFactor >= VOLUME_WEEK_MIN && titles.every((t) => sessionOf(w, t))
	);
	if (!weeks.length) return block;

	const minutes = input.sessionMinutes;
	const scales = weeks.map((w) => w.targets.volumeFactor);
	const muscles = new Map(libraryOf(input).map((e) => [e.key, e]));
	const ex = (key: ExerciseKey) => exerciseOf(input, key)!;
	const keyOf = (e: PlannedExercisePlan) => toExerciseKey(e.exercise);
	const count = (week: WeekPlan, sessions: SessionPlan[]): Tally => {
		const { groups } = plannedHardSets({ ...week, sessions }, muscles);
		const tally: Tally = {
			groups: Object.fromEntries(GROUPS.map((g) => [g, groups[g] ?? 0])) as Tally['groups'],
			push: 0,
			pull: 0
		};
		for (const e of sessions.flatMap((s) => (s.kind === 'strength' ? s.exercises : []))) {
			const { pattern } = ex(keyOf(e));
			for (const line of e.sets) {
				if (!isHardSet(!NON_WORKING_ROLES.includes(line.role), line.targetRpe)) continue;
				if (PUSH_PATTERNS.includes(pattern)) tally.push += line.sets;
				if (PULL_PATTERNS.includes(pattern)) tally.pull += line.sets;
			}
		}
		return tally;
	};

	const edits = new Map<string, Edit>(titles.map((t) => [t, { added: [], sets: new Map() }]));
	const edited = (week: WeekPlan, title: string, edit = edits.get(title)!) =>
		withEdit(sessionOf(week, title)!, edit, split, week.targets.rpeCap, input);
	/** `s` in week `w` as progression will leave it, with that week's volume factor applied. */
	const ahead = (w: number, s: StrengthSessionPlan) =>
		withVolume({ ...weeks[w]!, sessions: [s] }, input, LOAD_RULES).sessions[0] as typeof s;
	/** A session's count as progression and timefit will leave it: one over its length trimmed. */
	const counted = (w: number, session: StrengthSessionPlan) => {
		const s = ahead(w, session);
		return count(weeks[w]!, [s.estMinutes > minutes ? fitSession(s, input, minutes).session : s]);
	};
	let current = weeks.map((w) => new Map(titles.map((t) => [t, edited(w, t)])));
	const own = new Map(titles.map((t) => [t, weeks.map((_, w) => counted(w, current[w]!.get(t)!))]));

	// The eligible work each group can gain: what trains only that group first, then accessories.
	const pools = GROUPS.map((g) => {
		const slot = {
			key: `volume.${g}`,
			patterns: MAJOR_GROUPS[g].patterns,
			discipline: split.discipline
		};
		const rank = (k: ExerciseKey) =>
			(ex(k).primaryMuscles.every((m) => MUSCLE_GROUP[m] === g) ? 0 : 2) +
			(isAccessory(ex(k)) ? 0 : 1);
		const keys = candidates(slot, input).keys.filter((k) =>
			ex(k).primaryMuscles.some((m) => MUSCLE_GROUP[m] === g)
		);
		return [g, keys.sort((a, z) => rank(a) - rank(z))] as const;
	});

	/** The moves from here; on a cut a main lift's back-offs may come off too, its top set never. */
	function moves(cutting: boolean): Move[] {
		const out: Move[] = [];
		const roomiest = [...titles].sort(
			(a, z) => current[0]!.get(a)!.estMinutes - current[0]!.get(z)!.estMinutes
		);
		for (const by of cutting ? ([-1] as const) : ([-1, 1] as const)) {
			for (const title of by < 0 ? titles : roomiest) {
				const session = current[0]!.get(title)!;
				const main = (e: PlannedExercisePlan) => e.sets.some((line) => line.role === 'top');
				const rank = (e: PlannedExercisePlan) => (main(e) ? 2 : isAccessory(ex(keyOf(e))) ? 0 : 1);
				const lines = session.exercises
					.flatMap((e, i) => e.sets.map((line, j) => ({ e, line, at: [i, j] as const })))
					.filter(({ e, line }) => !main(e) || (cutting && line.role === 'back_off'))
					.filter(({ line }) => (by < 0 ? line.sets > 1 : line.sets < MAX_LINE_SETS))
					.sort((l, r) => rank(l.e) - rank(r.e));
				for (const { e, at } of lines)
					out.push({ title, at, add: null, by, name: ex(keyOf(e)).name });
				if (by < 0 || edits.get(title)!.added.length >= MAX_ADDED_EXERCISES) continue;
				const used = new Set(session.exercises.map(keyOf));
				for (const [g, pool] of pools) {
					const key = pool.find((k) => !used.has(k));
					if (!key) continue;
					const add: Selected = {
						role: 'accessory',
						kind: MAJOR_GROUPS[g].kind,
						exercise: ex(key)
					};
					out.push({ title, at: null, add, by, name: add.exercise.name });
				}
			}
		}
		return out;
	}

	/**
	 * What one move adds to each week's tally: a set taken off, as timefit will then leave the
	 * session; a set added, as one more set, since it is added only while the session fits.
	 */
	const deltaOf = (move: Move): Tally[] =>
		weeks.map((week, w) => {
			const session = current[w]!.get(move.title)!;
			if (move.by < 0) {
				const after = edited(week, move.title, moved(edits.get(move.title)!, move));
				return plus(counted(w, after), own.get(move.title)![w]!, -1);
			}
			const e = move.add
				? plannedExercise(move.add, split, week.targets.rpeCap)
				: session.exercises[move.at![0]]!;
			const line = e.sets[move.at?.[1] ?? 0]!;
			return count(week, [{ ...session, exercises: [{ ...e, sets: [{ ...line, sets: 1 }] }] }]);
		});

	const entry = weeks.map((week) =>
		count(week, fitWeek(withVolume(week, input, LOAD_RULES), input).week.sessions)
	);
	let tallies = entry;
	const made: { move: Move; delta: Tally[] }[] = [];
	let short = new Set<MajorGroup | 'pulling'>();
	/**
	 * One set at a time toward `targets`, while any change brings the weeks closer. A cut only takes
	 * sets off, none that timefit would then give back to a group, and keeps what stayed short.
	 */
	function search(targets: Targets, cutting = false) {
		for (;;) {
			const now = distance(tallies, targets, scales);
			let best: { move: Move; delta: Tally[]; next: Tally[]; d: [number, number] } | null = null;
			if (!cutting) short = new Set();
			for (const move of closer([0, 0], now) ? moves(cutting) : []) {
				const delta = deltaOf(move);
				const next = tallies.map((t, w) => plus(t, delta[w]!));
				const d = distance(next, targets, scales);
				if (!closer(d, now) || (best && !closer(d, best.d))) continue;
				if (cutting && delta.some((t) => GROUPS.some((g) => t.groups[g] > 0))) continue;
				const edit = moved(edits.get(move.title)!, move);
				const tooLong = (w: number) =>
					ahead(w, edited(weeks[w]!, move.title, edit)).estMinutes > minutes;
				if (move.by > 0 && weeks.some((_, w) => tooLong(w))) {
					for (const g of GROUPS) {
						const lightest = spread(tallies, (t) => t.groups[g])[0];
						if (lightest < targets[g].floor && delta.some((t) => t.groups[g] > 0)) short.add(g);
					}
					if (tallies.some(pullsBehind) && delta.some((t) => t.pull > 0)) short.add('pulling');
					continue;
				}
				best = { move, delta, next, d };
			}
			if (!best) return;
			const { move } = best;
			edits.set(move.title, moved(edits.get(move.title)!, move));
			current = weeks.map((w, i) => current[i]!.set(move.title, edited(w, move.title)));
			own.set(
				move.title,
				weeks.map((_, w) => counted(w, current[w]!.get(move.title)!))
			);
			made.push(best);
			tallies = best.next;
		}
	}

	const style = split.maintenance
		? 'maintenance'
		: (STYLE_OF[split.discipline] ?? GENERAL_STYLE).style;
	const {
		sets: [lo, hi],
		suits
	} = HARD_SET_RANGES[style];
	const phaseKey = input.nutritionPhase;
	const phase = phaseKey ? PHASES[phaseKey] : undefined;
	const { keep, toward } = phase ?? { keep: 1, toward: 0 };
	const targetsBy = (target: (g: MajorGroup) => Targets[MajorGroup]) =>
		Object.fromEntries(GROUPS.map((g) => [g, target(g)])) as Targets;
	// A bulk raises the floor only as far as the heaviest week stays in the range.
	const spreadOf = (g: MajorGroup) => {
		return peak(entry, g, scales) - spread(entry, (t) => t.groups[g])[0];
	};
	let targets = targetsBy((g) => ({
		floor: Math.max(lo, Math.min(lo + toward * (hi - lo), hi - spreadOf(g))),
		ceiling: hi
	}));
	search(targets);
	if (keep < 1) {
		// The cut keeps `keep` of what the goal's sets came to, lightest and heaviest weeks alike.
		const planned = GROUPS.map((g) => [
			spread(tallies, (t) => t.groups[g])[0],
			peak(tallies, g, scales)
		]);
		targets = targetsBy((g) => {
			const [least, most] = planned[GROUPS.indexOf(g)]!;
			return { floor: keep * Math.max(lo, least!), ceiling: keep * Math.max(lo, most!) };
		});
		search(targets, true);
		for (const g of GROUPS)
			if (spread(tallies, (t) => t.groups[g])[0] >= keep * lo) short.delete(g);
		if (!tallies.some(pullsBehind)) short.delete('pulling');
	}

	const half = (n: number) => Math.round(n * 2) / 2;
	const band =
		keep < 1
			? `the ${half(keep * lo)}–${half(keep * hi)} that suits ${suits} on a cut`
			: `the ${toward > 0 ? 'top of the ' : ''}${lo}–${hi} that suits ${suits}`;
	const refs = [`blocks.${b}`];
	/**
	 * What changed for the count `credited` reads, after the phase's reason: each exercise's net
	 * change in sets, among those that count a whole set toward it, or else any that count.
	 */
	const because = (credited: (d: Tally) => number) => {
		const net = (least: number) => {
			const sets = new Map<string, number>();
			for (const { move, delta } of made) {
				if (delta.some((d) => Math.abs(credited(d)) >= least))
					sets.set(move.name, (sets.get(move.name) ?? 0) + move.by);
			}
			return [...sets];
		};
		const counted = net(1).some(([, n]) => n !== 0) ? net(1) : net(0.5);
		const up = counted.filter(([, n]) => n > 0).map(([name]) => name);
		const down = counted.filter(([, n]) => n < 0).map(([name]) => name);
		const few = (names: string[]) =>
			names.length > 3
				? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
				: listing(names);
		const change = [
			up.length ? `sets were added to ${few(up)}` : '',
			down.length ? `sets came off ${few(down)}` : ''
		]
			.filter(Boolean)
			.join(', and ');
		const text = change ? [phase?.why, change].filter(Boolean).join(': ') : '';
		return clip(text && ` ${text.charAt(0).toUpperCase()}${text.slice(1)}.`, 200);
	};
	for (const g of GROUPS) {
		const [before, after] = [
			spread(entry, (t) => t.groups[g]),
			spread(tallies, (t) => t.groups[g])
		];
		const over = after[1] > keep * hi + EPSILON;
		if (before[0] === after[0] && before[1] === after[1] && !over) continue;
		const pulling =
			MAJOR_GROUPS[g].patterns.some((p) => PULL_PATTERNS.includes(p)) &&
			tallies.some((t) => t.pull - t.push * PULL_PER_PUSH < 1);
		const why = (): string => {
			if (!over) return '';
			if (peak(tallies, g, scales) <= keep * hi + EPSILON) return OVER.overreach;
			return after[0] <= keep * hi ? OVER.heaviest : OVER[pulling ? 'pulling' : 'every'];
		};
		log.add('volume_adjusted', phase ? `volume.${phaseKey}` : `volume.${style}`, refs, {
			group: MUSCLE_GROUP_LABEL[g],
			sets: words(after),
			target: band,
			reason: because((d) => d.groups[g]),
			over: why()
		});
	}
	if (entry.some(pullsBehind) && made.some((m) => m.delta.some((d) => d.push || d.pull))) {
		log.add('volume_adjusted', 'volume.push_pull', refs, {
			group: 'Pulling',
			sets: words(spread(tallies, (t) => t.pull)),
			target: `at least as many as pushing gets (${words(spread(tallies, (t) => t.push))}), so the shoulders stay balanced`,
			reason: because((d) => Math.abs(d.push) + Math.abs(d.pull)),
			over: ''
		});
	}
	if (short.size) {
		const named = [...GROUPS, 'pulling' as const]
			.filter((g) => short.has(g))
			.map((g) => (g === 'pulling' ? g : MUSCLE_GROUP_LABEL[g].toLowerCase()));
		log.add('priority_tradeoff', 'volume.session_length', refs, {
			kept: `Your ${minutes}-minute sessions`,
			given: clip(`more ${listing(named)} work`, 120),
			reason: clip(
				`Reaching ${band} would take more sets than your ${minutes}-minute sessions hold, so the session length comes first.`,
				200
			)
		});
	}

	return {
		...block,
		weeks: block.weeks.map((week) => ({
			...week,
			sessions: week.sessions.map((s) => (isStrength(s) ? edited(week, s.title) : s))
		}))
	};
}
