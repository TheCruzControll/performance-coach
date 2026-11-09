/**
 * The mock coach's scripts for the history tools. Each answer is computed from the turn's tool
 * results, so every number in a fact is one a tool returned, cited by the set it came from, and
 * neither script writes text between its tool calls:
 * - 'How has my bench progressed over the last month?' reads the bench's sets and compares the
 *   top set of the first and the last session of the last 28 days, with the best estimated 1RM.
 *   It reads one page of sets; when that page ends inside the 28 days it compares from the oldest
 *   whole session read and says the comparison is not the full month, or that it can't compare
 *   when fewer than two whole sessions were read.
 * - 'Should I increase my squat weight?' reads the squat's sets and records, states the last
 *   session's working sets with their RPEs, then recommends from those RPEs (SQUAT_PROGRESSION).
 */
import { addDays } from '../../../../domain/calendar.ts';
import { DEFAULT_LOAD_INCREMENT } from '../../../../domain/units.ts';
import type { MockContext, MockScript } from '../mock.ts';

const BENCH = /\bbench\b.*\bprogress/i;
const SQUAT = /\b(increase|raise|add|go up)\b.*\bsquat\b|\bsquat\b.*\b(heavier|increase)\b/i;
/** The window 'the last month' reads, today included. */
const MONTH_DAYS = 28;
/**
 * Decision: the template's progression rule: add the smallest loadable step (M1's
 * DEFAULT_LOAD_INCREMENT) when every working set of the last session was at most this RPE.
 */
export const SQUAT_PROGRESSION = Object.freeze({ maxRpe: 8, step: DEFAULT_LOAD_INCREMENT });

interface Ref {
	type: string;
	id: string;
	date?: string;
}
interface LoggedSet {
	source: Ref;
	weight: number | null;
	unit: 'kg' | 'lb';
	reps: number | null;
	rpe: number | null;
	warmup: boolean;
	skipped: boolean;
}
interface Records {
	bestE1rm: { value: number; unit: string; method: string; sources: Ref[] } | null;
}
interface History {
	error?: string;
	records: Records;
	sets: LoggedSet[];
	next: number | null;
}

const cite = (ref: Ref) => `[[${ref.type}:${ref.id}]]`;
const load = (s: LoggedSet) => `${s.weight} ${s.unit} × ${s.reps}`;

/** Working sets with a load and reps, newest first, grouped by day: newest day first. */
function sessions(sets: readonly LoggedSet[]): Map<string, LoggedSet[]> {
	const days = new Map<string, LoggedSet[]>();
	for (const s of sets) {
		if (s.warmup || s.skipped || s.weight === null || s.reps === null || !s.source.date) continue;
		days.set(s.source.date, [...(days.get(s.source.date) ?? []), s]);
	}
	return days;
}

const top = (sets: readonly LoggedSet[]) =>
	sets.reduce((best, s) =>
		s.weight! > best.weight! || (s.weight === best.weight && s.reps! > best.reps!) ? s : best
	);

function bestE1rm({ bestE1rm: best }: Records): string[] {
	if (!best) return [];
	const [source] = best.sources;
	return [
		`[metric method=${best.method}] Best estimated 1RM: ${best.value} ${best.unit} ${cite(source!)}`
	];
}

function benchAnswer(context: MockContext): string {
	const history = context.result('get_exercise_history') as History;
	if (history.error) return '[note] I couldn’t find your bench press in your library.';
	const read = [...sessions(history.sets)];
	const newest = read[0]?.[0];
	const today = (context.turnContext?.date as string | undefined) ?? newest;
	const since = today && addDays(today, 1 - MONTH_DAYS);
	// With older sets unread, the oldest day read may continue on the next page: leave it out.
	const cut = history.next === null ? undefined : read.pop()?.[0];
	const partial = cut !== undefined && since !== undefined && cut >= since;
	const month = read.filter(([day]) => since !== undefined && day >= since);
	if (month.length < 2 && partial)
		return '[note] One read of your bench sets doesn’t hold two whole sessions from the last four weeks, and older sets are still unread, so I can’t compare your progression from it.';
	if (month.length < 2)
		return `[note] You have ${month.length === 0 ? 'no bench sessions' : 'one bench session'} logged in the last four weeks, so there is no progression to compare yet.`;
	const [lastDay, lastSets] = month[0]!;
	const [firstDay, firstSets] = month.at(-1)!;
	const first = top(firstSets);
	const last = top(lastSets);
	const direction =
		last.weight! > first.weight! || (last.weight === first.weight && last.reps! > first.reps!)
			? 'up'
			: last.weight === first.weight && last.reps === first.reps
				? 'level'
				: 'down';
	return [
		partial
			? `Since ${firstDay} your bench top set is ${direction}; the last four weeks hold more bench sets than one read returns, so this is not the full month.`
			: `Over the last four weeks your bench top set is ${direction}.`,
		`[fact] ${firstDay}: top set ${load(first)} ${cite(first.source)}`,
		`[fact] ${lastDay}: top set ${load(last)} ${cite(last.source)}`,
		...bestE1rm(history.records)
	].join('\n\n');
}

function squatAnswer(context: MockContext): string {
	const history = context.result('get_exercise_history') as History;
	const records = context.result('get_personal_records') as { items?: Records[] };
	if (history.error) return '[note] I couldn’t find your squat in your library.';
	const [last] = sessions(history.sets);
	if (!last)
		return '[note] You have no squat sets logged yet, so there is nothing to base a weight change on. Log a session and ask again.';
	const [day, newestFirst] = last;
	const sets = [...newestFirst].reverse();
	const heaviest = top(sets);
	const rpes = sets.map((s) => s.rpe);
	const facts = [
		`[fact] Last squat session, ${day}: ${sets.map((s) => `${load(s)} at RPE ${s.rpe ?? '?'}`).join('; ')} ${sets.map((s) => cite(s.source)).join(' ')}`,
		...bestE1rm(records.items?.[0] ?? history.records)
	];
	const step = SQUAT_PROGRESSION.step[heaviest.unit];
	const recommendation = rpes.some((rpe) => rpe === null)
		? '[recommendation] Some of those sets have no RPE logged, so I can’t tell how hard they were. Log RPE on your next squat session and I’ll judge the increase from it.'
		: rpes.every((rpe) => rpe! <= SQUAT_PROGRESSION.maxRpe)
			? `[recommendation] Every working set was RPE ${SQUAT_PROGRESSION.maxRpe} or easier, so add ${step} ${heaviest.unit} next session and keep the same reps.`
			: `[recommendation] Your last session reached RPE ${Math.max(...(rpes as number[]))}, so stay at ${heaviest.weight} ${heaviest.unit} until every working set is RPE ${SQUAT_PROGRESSION.maxRpe} or easier.`;
	return ['Here’s what your last squat session says.', ...facts, recommendation].join('\n\n');
}

export const historyScripts: readonly MockScript[] = [
	{
		name: 'bench-progress',
		matches: (text) => BENCH.test(text),
		steps: [
			{ tools: [{ name: 'get_exercise_history', input: { exercise: 'bench' } }] },
			{ text: benchAnswer }
		]
	},
	{
		name: 'squat-increase',
		matches: (text) => SQUAT.test(text),
		steps: [
			{
				tools: [
					{ name: 'get_exercise_history', input: { exercise: 'squat' } },
					{ name: 'get_personal_records', input: { exercise: 'squat' } }
				]
			},
			{ text: squatAnswer }
		]
	}
];
