/**
 * The weekly review's sections after its trends (PRD §11), arranged on the server from the stored
 * findings (domain/programming/review/weekly.ts) so the screen computes nothing: RPE against
 * target, volume and intensity, running, Muay Thai, recovery and fatigue, conflicts and PRs. Each
 * section has one verdict line, the line a phone shows while the section is collapsed: its first
 * finding to watch, otherwise its lead finding. RPE and hard sets per group also become chart
 * data (DivergingBars, RangeBars) with their frame and table twin, every number from the snapshot.
 */
import type { Finding, FindingLevel } from '#lib/domain/programming/review/brief.ts';
import type { WeeklyReviewSnapshot } from '#lib/domain/programming/review/snapshot.ts';
import { plural } from '#lib/domain/programming/review/weekly.ts';
import {
	DIVERGE_WORDS,
	divergeTone,
	divergingTable,
	RANGE_STATUS,
	rangeStatus,
	rangeTable,
	rowsHeight,
	type DivergingBarsData,
	type RangeBarsData
} from '#lib/ui/charts/bar-model.ts';
import { SERIES_TOKEN } from '#lib/ui/charts/palette.ts';
import type { ChartTableData } from '#lib/ui/charts/table.ts';

export const SECTION_IDS = [
	'rpe',
	'volume',
	'running',
	'muay_thai',
	'recovery',
	'conflicts',
	'prs'
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const SECTION_TITLE: Record<SectionId, string> = {
	rpe: 'RPE against target',
	volume: 'Volume and intensity',
	running: 'Running',
	muay_thai: 'Muay Thai',
	recovery: 'Recovery and fatigue',
	conflicts: 'Conflicting demands',
	prs: 'Personal records'
};

/** What a section with nothing found says: conflicts and PRs are always shown. */
export const NOTHING_FOUND: Partial<Record<SectionId, { level: FindingLevel; words: string }>> = {
	conflicts: { level: 'good', words: 'No sessions got in each other’s way this week' },
	prs: { level: 'neutral', words: 'No new records this week' }
};

export interface FigureView {
	label: string;
	words: string;
	/** Canonical, for a test to read (data-value); null: no data. */
	value: number | null;
}

export interface ItemView {
	id: string;
	label: string;
	words: string;
	figures: FigureView[];
	/** Each reason in its own line (fatigue). */
	reasons: string[];
}

interface Frame {
	title: string;
	context: string[];
	summary: string;
	table: ChartTableData;
	height: string;
}

export type ChartView =
	| ({ body: 'diverging'; data: DivergingBarsData } & Frame)
	| ({ body: 'range'; data: RangeBarsData } & Frame);

export interface SectionView {
	id: SectionId;
	title: string;
	verdict: { level: FindingLevel; words: string };
	items: ItemView[];
	chart: ChartView | null;
}

const WATCH: readonly FindingLevel[] = ['low', 'watch'];
const valueOf = (f: Finding, label: string) => f.figures.find((g) => g.label === label)?.value;
const lead = (f: Finding) => `${f.label}: ${f.verdict.words}`;

/** Lists 'a', 'a and b', 'a, b and c'. */
const list = (words: string[]) =>
	words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;

function item(f: Finding, reasons: string[] = []): ItemView {
	// Fatigue's words are its reasons, then any advice: the reasons become lines of their own.
	const said = reasons.join('. ');
	const rest = f.verdict.words.startsWith(said) ? f.verdict.words.slice(said.length) : '';
	return {
		id: f.id,
		label: f.label,
		words: reasons.length
			? rest.replace(/^\. /, '') || `${plural(reasons.length, 'signal')} this week`
			: f.verdict.words,
		figures: f.figures.map(({ label, words, value }) => ({ label, words, value })),
		reasons
	};
}

/** RPE against target per lift, a row a lift; null when no lift had both RPEs. */
function rpeChart(lifts: Finding[]): ChartView | null {
	const rows = lifts.flatMap((f) => {
		const [actual, target] = [valueOf(f, 'Actual'), valueOf(f, 'Target')];
		if (actual == null || target == null) return [];
		const label = f.label.replace(/ RPE against target$/, '');
		return [{ key: f.id.slice('rpe:'.length), label, actual, target }];
	});
	if (rows.length === 0) return null;
	const data = { title: SECTION_TITLE.rpe, rows };
	const off = (['below', 'above'] as const).flatMap((tone) => {
		const names = rows.filter((r) => divergeTone(r.actual - r.target) === tone);
		return names.length ? [`${list(names.map((r) => r.label))}: ${DIVERGE_WORDS[tone]}`] : [];
	});
	return {
		body: 'diverging',
		data,
		title: data.title,
		context: ['This week', 'Against target RPE', 'Reported'],
		summary: off.length
			? `${off.join('. ')} than prescribed.`
			: 'Every lift was on its target RPE.',
		table: divergingTable(data),
		height: rowsHeight(rows.length)
	};
}

/** Hard sets per group against the week's scaled range; null when no group has a range. */
function setsChart(groups: Finding[]): ChartView | null {
	const bar = (value: number) => ({ value, text: String(value) });
	const rows = groups.flatMap((f) => {
		const [done, low, high] = ['Done', 'Target low', 'Target high'].map((l) => valueOf(f, l));
		if (low == null || high == null) return [];
		const planned = valueOf(f, 'Planned');
		return [
			{
				key: f.id.slice('volume:sets:'.length),
				label: f.label.replace(/ hard sets$/, ''),
				value: done == null ? null : bar(done),
				range: [low, high] as const,
				planned: planned == null ? null : bar(planned)
			}
		];
	});
	if (rows.length === 0) return null;
	const data = {
		title: 'Hard sets by muscle group',
		unit: 'sets',
		token: SERIES_TOKEN.hypertrophy,
		rows
	};
	const within = rows.filter((r) => r.value && rangeStatus(r.value.value, r.range) === 'within');
	const off = (['below', 'above'] as const).flatMap((status) => {
		const names = rows.filter((r) => r.value && rangeStatus(r.value.value, r.range) === status);
		return names.length
			? [`${RANGE_STATUS[status].toLowerCase()}: ${list(names.map((r) => r.label))}`]
			: [];
	});
	const summary = `${within.length} of ${plural(rows.length, 'group')} within range${off.length ? `; ${off.join('; ')}` : ''}.`;
	return {
		body: 'range',
		data,
		title: data.title,
		context: ['This week', 'Against your target ranges', 'Calculated'],
		summary: summary[0]!.toUpperCase() + summary.slice(1),
		table: rangeTable(data),
		height: rowsHeight(rows.length)
	};
}

/** The sections after the trends, in screen order; a section with nothing to show is left out. */
export function reviewSections(snapshot: WeeklyReviewSnapshot): SectionView[] {
	const findings = snapshot.brief.findings;
	const of = (...sections: Finding['section'][]) =>
		findings.filter((f) => sections.includes(f.section));
	return SECTION_IDS.flatMap((id): SectionView[] => {
		const found = id === 'recovery' ? of('fatigue', 'recovery') : of(id);
		let chart: ChartView | null = null;
		if (id === 'rpe') chart = rpeChart(found.filter((f) => f.id !== 'rpe:average'));
		if (id === 'volume') chart = setsChart(found.filter((f) => f.id.startsWith('volume:sets:')));
		const prefix = id === 'rpe' ? 'rpe:' : 'volume:sets:';
		const charted = new Set(chart?.data.rows.map((r) => `${prefix}${r.key}`));
		// A charted finding needs no line of its own, except one to watch, which says why.
		const listed = found.filter((f) => !charted.has(f.id) || WATCH.includes(f.verdict.level));
		const items = listed.map((f) =>
			item(f, f.id === 'fatigue' && snapshot.fatigue.reasons.length ? snapshot.fatigue.reasons : [])
		);
		const flagged = found.find((f) => WATCH.includes(f.verdict.level));
		let verdict: SectionView['verdict'];
		if (found.length === 0) {
			const none = NOTHING_FOUND[id];
			if (!none) return [];
			verdict = none;
		} else if (id === 'conflicts' || id === 'prs') {
			const what =
				id === 'prs' ? plural(found.length, 'new record') : plural(found.length, 'conflict');
			const more = found.length > 1 ? ` and ${found.length - 1} more` : '';
			verdict = { level: found[0]!.verdict.level, words: `${what}: ${found[0]!.label}${more}` };
		} else {
			const f = flagged ?? found[0]!;
			verdict = { level: f.verdict.level, words: lead(f) };
		}
		return [{ id, title: SECTION_TITLE[id], verdict, items, chart }];
	});
}
