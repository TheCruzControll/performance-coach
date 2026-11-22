/**
 * A week's findings as Train shows them (m7/04 train-week-findings): evaluateWeek over the week
 * as the store holds it, in calm words, for the session cards and the week line. Imported by path:
 * services/index.ts does not re-export it, and the folder has no index file.
 *
 * - It reads the week and the Sunday before it (a clash can cross the weekend) through M3's
 *   repository, one query at a time, and maps them as every program read does (toStoredSessions).
 *   The owner's own exercises supply their traits; skipped sessions are left out by the judge.
 * - Only what the owner can still act on is shown: a finding on days still ahead, on its sessions
 *   dated today or later that are not done yet, at most MAX_SHOWN of them, avoid first.
 * - Owner-scoped: the version is read from the owner's active program by number, so another
 *   owner's version is not found and nothing of theirs is read.
 */
import { addDays, type IsoDate } from '../../../domain/calendar';
import type { Finding, WeekEvaluation } from '../../../domain/programming/evaluate/types';
import { evaluateWeek, type PriorityHint } from '../../../domain/programming/evaluate/week';
import { catalogueTraits, type TraitsOf } from '../../../domain/programming/interference';
import { createProgramsRepository } from '../../db/repositories/programs';
import { measure } from '../../observability/timing';
import { getExercisesByIds } from '../exercises/index';
import { toStoredSessions, type StoredSession } from '../programs/mapping';
import { resolveDeps, TrainingNotFoundError, type TrainingDeps } from '../training/shared';

/** A finding on one session's card, in words: its kind, what and where, and the rule's reason. */
export interface FindingNote {
	/** caution only for an avoid finding nobody explained, or the owner's own move. */
	tone: 'neutral' | 'caution';
	label: string;
	/** The line as the card shows it, label first: 'Heads-up · Heavy lower body … · You moved this here'. */
	text: string;
	/** The rule's reason, then why the week keeps it, when it does. */
	why: string;
}

export interface WeekFindingsView {
	grade: WeekEvaluation['grade'];
	/** The week line, counting the findings shown; null for a week that has ended. */
	summary: string | null;
	/** By session lineage: the note on each card a finding shown names. */
	notes: Record<string, FindingNote>;
}

export interface WeekAt {
	/** The version's number in the owner's active program. */
	version: number;
	/** The week's Monday. */
	weekStartsOn: IsoDate;
	/** The owner's today: what came before it is past. */
	today: IsoDate;
	/** The generator's priority trade-offs on the week's sessions (explain.ts), newest first. */
	tradeoffs?: readonly TradeoffDecision[];
}

/** A priority_tradeoff decision: its sentence and the lineages it names. */
export interface TradeoffDecision {
	why: string;
	affected: readonly string[];
}

/**
 * Each trade-off as the judge's hint (m7/14): it becomes the resolution of the finding that
 * names a session it affected, so the card says why the week keeps the clash. A session keeps
 * only its newest trade-off: the judge reads its hints in its own order.
 */
export function tradeoffHints(tradeoffs: readonly TradeoffDecision[]): PriorityHint[] {
	const hints = new Map<string, PriorityHint>();
	for (const { why, affected } of tradeoffs) {
		for (const lineage of affected) {
			if (!hints.has(lineage))
				hints.set(lineage, { kind: 'priority_tradeoff', lineage, text: why });
		}
	}
	return [...hints.values()];
}

/**
 * Decision (m7-plan, train-week-findings; owner open question on Train's findings): the most
 * findings a week shows, avoid first. The week line counts the same ones, so it never names a
 * finding the cards do not show.
 */
export const MAX_SHOWN = 3;

/**
 * The words a note opens with (m7-plan: words carry the meaning, never a colour alone):
 * - headsUp: an avoid rule broken on a day ahead with no reason given, or the owner's own move
 * - yourMove: advice (a prefer rule) the owner may act on
 * - tradeOff: kept for a stated reason: a commitment, a goal's priority, or no free day
 */
export const NOTE_LABEL = {
	headsUp: 'Heads-up',
	yourMove: 'Your move',
	tradeOff: 'Trade-off, explained'
} as const;

/** 'Lower A', 'Lower A and Easy run', 'A, B and C'; '' for none. */
const andList = (names: readonly string[]) =>
	names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');

function labelOf({ severity, resolution }: Finding): Pick<FindingNote, 'label' | 'tone'> {
	if (resolution && resolution.kind !== 'owner_moved') {
		return { label: NOTE_LABEL.tradeOff, tone: 'neutral' };
	}
	if (resolution || severity === 'avoid') return { label: NOTE_LABEL.headsUp, tone: 'caution' };
	return { label: NOTE_LABEL.yourMove, tone: 'neutral' };
}

/** Where the finding's other sessions sit from this one: 'After Lower A the day before'. */
function whereOf(finding: Finding, lineage: string, moved: boolean): string {
	if (moved) return 'You moved this here';
	const at = finding.sessions.findIndex((s) => s.lineage === lineage);
	const self = finding.sessions[at]!;
	const names = (pick: (s: Finding['sessions'][number], i: number) => boolean) =>
		andList(finding.sessions.filter((s, i) => i !== at && pick(s, i)).map((s) => s.title));
	const before = names((s, i) => s.date < self.date || (s.date === self.date && i < at));
	if (before) {
		const day = finding.sessions.some((s) => s.date < self.date)
			? 'the day before'
			: 'the same day';
		return `After ${before} ${day}`;
	}
	const after = names((s) => s.date > self.date);
	return after ? `The day before ${after}` : `Before ${names(() => true)} the same day`;
}

/** The line for the findings on the cards: '1 heads-up this week', 'No clashes ahead this week'. */
function summaryOf(shown: readonly Finding[], current: boolean): string {
	const tradeOffs = shown.filter((f) => labelOf(f).label === NOTE_LABEL.tradeOff).length;
	const headsUps = shown.length - tradeOffs;
	const parts = [
		...(headsUps ? [`${headsUps} heads-up${headsUps > 1 ? 's' : ''} this week`] : []),
		...(tradeOffs ? [`${tradeOffs} trade-off${tradeOffs > 1 ? 's' : ''}, explained`] : [])
	];
	if (parts.length) return parts.join(' and ');
	return current ? 'No clashes ahead this week' : 'No clashes this week';
}

/** The owner's own exercises in `sessions` by id, after the catalogue's. */
async function traitsFor(ownerId: string, sessions: readonly StoredSession[], deps: TrainingDeps) {
	const ids = sessions.flatMap((s) =>
		s.kind === 'strength'
			? s.exercises.flatMap(({ exercise }) => ('customId' in exercise ? [exercise.customId] : []))
			: []
	);
	const custom = ids.length ? await getExercisesByIds(ownerId, ids, deps) : new Map();
	const traitsOf: TraitsOf = (ref) =>
		'key' in ref ? catalogueTraits(ref) : custom.get(ref.customId);
	return traitsOf;
}

/** The week `at` names judged, in Train's words. TrainingNotFoundError: no such version. */
export async function getWeekEvaluation(
	ownerId: string,
	{ version, weekStartsOn, today, tradeoffs = [] }: WeekAt,
	deps: TrainingDeps = {}
): Promise<WeekFindingsView> {
	const { db } = resolveDeps(deps);
	return measure('periodisation', async () => {
		const repo = createProgramsRepository(db);
		const found = await repo.currentProgram(ownerId, version);
		if (!found) throw new TrainingNotFoundError('program version');
		const sunday = addDays(weekStartsOn, -1);
		const weekEnd = addDays(weekStartsOn, 6);
		const weeks = (await repo.versionWeeks(found.version.id)).filter(
			(w) => w.startsOn <= weekEnd && w.endsOn >= sunday
		);
		const rows = weeks.length ? await repo.weekSessions(weeks.map((w) => w.id)) : null;
		const sessions = rows
			? [...toStoredSessions(rows).values()].filter((s) => s.date >= sunday && s.date <= weekEnd)
			: [];
		const ahead = sessions.filter((s) => s.date >= today && s.date >= weekStartsOn);
		const done = await repo.completedLineages(
			ownerId,
			ahead.map((s) => s.lineage)
		);
		const openDates = Array.from({ length: 7 }, (_, i) => addDays(weekStartsOn, i)).filter(
			(date) => date >= today
		);
		const evaluation = evaluateWeek(sessions, {
			traitsOf: await traitsFor(ownerId, sessions, { db }),
			openDates,
			hints: tradeoffHints(tradeoffs),
			today
		});

		// What the owner can still act on: its sessions ahead that are not done, avoid first.
		const byLineage = new Map(ahead.filter((s) => !done.has(s.lineage)).map((s) => [s.lineage, s]));
		const actable = (f: Finding) => f.sessions.filter((s) => s.lineage && byLineage.has(s.lineage));
		const shown = evaluation.findings
			.filter((f) => actable(f).length > 0)
			.sort((a, b) => Number(a.severity !== 'avoid') - Number(b.severity !== 'avoid'))
			.slice(0, MAX_SHOWN);
		const notes: Record<string, FindingNote> = {};
		// The week line counts only the findings that put a note on a card (a card keeps one).
		const placed: Finding[] = [];
		for (const finding of shown) {
			for (const { lineage } of actable(finding)) {
				if (notes[lineage!]) continue;
				if (placed.at(-1) !== finding) placed.push(finding);
				const moved =
					finding.resolution?.kind === 'owner_moved' && byLineage.get(lineage!)!.status === 'moved';
				const { label, tone } = labelOf(finding);
				notes[lineage!] = {
					tone,
					label,
					text: `${label} · ${finding.headline} · ${whereOf(finding, lineage!, moved)}`,
					why: [finding.why, finding.resolution?.text].filter(Boolean).join(' ')
				};
			}
		}
		return {
			grade: evaluation.grade,
			summary: weekEnd < today ? null : summaryOf(placed, weekStartsOn <= today),
			notes
		};
	});
}
