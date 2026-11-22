/**
 * The periodisation road (m7/37 road-view): one owner-scoped read model of the blocks, each goal's
 * mode, the events, and the deloads and tapers from today to the plan's end, for the timeline,
 * the coach's context and its explain tool. Imported by path: services/index.ts does not
 * re-export it, and the folder has no index file.
 *
 * - Reads, one query at a time: the owner's active program and its current version, that
 *   version's blocks and weeks through M3's versionTree (versionOutline), the priority_resolved
 *   and maintenance_dose decisions naming any of its blocks (ended ones too: a season window's
 *   decision names only the block holding its first day), and the input each block was planned
 *   from. Blocks that end before today are left out.
 * - Each goal's mode at a block's start is the generator's own rule (stages/prepare.ts):
 *   effectivePriorities over the block's input at its phase, every goal held in a maintenance
 *   block, and in a recovery block (M7's season holds them all there). A block takes its leader
 *   from the newest priority_resolved whose from..until covers its start, whichever block that
 *   decision names (the evidence's goalRef, or its leader's title before M7 stored refs). A dose that holds
 *   a secondary goal for part of a block (an overlap with a later run-up) leaves it secondary:
 *   the road shows the modes a block starts with.
 * - A program with no mode decisions at all (built before M7) shows each block's modes worked out
 *   from its input, labelled DERIVED_MODES_NOTE; an M7-built program's blocks carry no note. A pre-M7 half's marathon_* phases read 'Half marathon …',
 *   from its goal's event. A maintenance block reads MAINTENANCE_LABEL; M6's bridge between
 *   blocks reads 'Between blocks', with no goals.
 * - serialiseRoad gives the coach the road in at most ROAD_TEXT_MAX_BYTES.
 */
import { daysBetween, mondayOf, type IsoDate } from '../../../domain/calendar';
import type { Discipline } from '../../../domain/profile/catalog';
import { clip } from '../../../domain/programming/demand';
import type { GoalMode } from '../../../domain/programming/evaluate/types';
import type { InputGoal, ProgrammingInput } from '../../../domain/programming/input';
import { holdEveryGoal } from '../../../domain/programming/priority/doses';
import {
	effectivePriorities,
	eventKindOf,
	type GoalPriority
} from '../../../domain/programming/priority/weights';
import {
	PHASE_LABEL,
	WEEK_KIND_LABEL,
	type DecisionKind,
	type Phase,
	type WeekKind
} from '../../../domain/training/vocabulary';
import { createAnalyticsRepository } from '../../db/repositories/analytics';
import {
	createPeriodisationRepository,
	type LineageDecisionRow
} from '../../db/repositories/periodisation';
import { createProgramsRepository } from '../../db/repositories/programs';
import { measure } from '../../observability/timing';
import { resolveDeps, type TrainingDeps } from '../training/shared';

/** The decisions whose evidence names a goal's mode (m7-plan, road-view). */
export const MODE_KINDS = [
	'priority_resolved',
	'maintenance_dose'
] as const satisfies readonly DecisionKind[];

/** Decision (m7-plan, road-view): the most mode decisions one road reads; a plan writes ~20. */
export const MAX_MODE_DECISIONS = 300;

/** What a block whose modes no decision records says about them (programs before M7). */
export const DERIVED_MODES_NOTE = 'worked out from your goals';

/** A maintenance block's label. */
export const MAINTENANCE_LABEL = 'Maintenance · every goal held';

/** Decision (m7-plan, road-view): the coach's serialised road stays within 1.5 KB. */
export const ROAD_TEXT_MAX_BYTES = 1536;

/** M6's late start: next-block/dates.ts's BRIDGE_PHASE (server-only there, named again here). */
const BRIDGE_PHASE: Phase = 'transition';

export interface RoadGoal {
	/** The goal's M2 uuid. */
	ref: string;
	title: string;
	discipline: Discipline | null;
	mode: GoalMode;
}

export interface RoadWeek {
	startsOn: IsoDate;
	kind: WeekKind;
	current: boolean;
}

export interface RoadBlock {
	lineage: string;
	phase: Phase;
	/** 'Fight camp', 'Half marathon build', MAINTENANCE_LABEL or 'Between blocks'. */
	label: string;
	startsOn: IsoDate;
	endsOn: IsoDate;
	/** Dated, its weeks not planned yet (and so none listed). */
	outline: boolean;
	weeks: RoadWeek[];
	/** The leader first; none in a bridge, or without the input the block was planned from. */
	goals: RoadGoal[];
	/** DERIVED_MODES_NOTE in a program built before M7 (no mode decisions); null otherwise. */
	modesNote: string | null;
}

export interface RoadEvent {
	goalTitle: string;
	date: IsoDate;
	/** Whole weeks from today. */
	weeksAway: number;
}

export interface RoadMarker {
	/** The Monday of the week it starts. */
	week: IsoDate;
	kind: 'deload' | 'taper';
	label: string;
}

export interface RoadView {
	blocks: RoadBlock[];
	/** The events still ahead, soonest first. */
	events: RoadEvent[];
	/** Deloads and tapers from this week on, in date order. */
	markers: RoadMarker[];
	/** Indexes into `blocks` and its weeks; null before the program starts or between them. */
	current: { block: number; week: number | null } | null;
}

type Evidence = Record<string, unknown>;
const evidenceOf = (row: LineageDecisionRow): Evidence =>
	row.evidence && typeof row.evidence === 'object' ? (row.evidence as Evidence) : {};

/** The goals a block's modes cover: M3's shaping goals, with their refs. */
function shaping(input: ProgrammingInput): { goal: InputGoal; ref: string }[] {
	const goals = input.maintenance ? input.paused : input.goals;
	const refs = input.maintenance ? input.refs.paused : input.refs.goals;
	return goals.map((goal, i) => ({ goal, ref: refs[i]! }));
}

/** 'Half marathon build' for a half M3 planned as marathon_build. */
function labelOf(phase: Phase, input: ProgrammingInput | null, goalRefs: readonly string[]) {
	if (phase === 'maintenance') return MAINTENANCE_LABEL;
	const step = /^marathon_(base|build|peak|taper)$/.exec(phase)?.[1];
	if (step && input) {
		const events = shaping(input).filter(({ goal }) => eventKindOf(goal) !== null);
		const served = events.find(({ ref }) => goalRefs.includes(ref)) ?? events[0];
		const kind = served && eventKindOf(served.goal);
		if (kind === 'half') return PHASE_LABEL[`half_${step}` as Phase];
	}
	return PHASE_LABEL[phase] ?? phase;
}

/** The leader the newest decision covering `startsOn` names, by ref or (before refs) title. */
function decidedLeader(rows: readonly LineageDecisionRow[], startsOn: IsoDate) {
	const covering = rows
		.filter((r) => r.kind === 'priority_resolved')
		.map(evidenceOf)
		.find((e) => String(e.from) <= startsOn && startsOn <= String(e.until));
	if (!covering) return null;
	return { ref: covering.goalRef as string | undefined, title: covering.leader as string };
}

function goalsOf(
	input: ProgrammingInput,
	phase: Phase,
	startsOn: IsoDate,
	rows: readonly LineageDecisionRow[]
): RoadGoal[] {
	const computed = effectivePriorities(input, startsOn, { phase });
	const held = phase === 'maintenance' || phase === 'recovery';
	let priorities: GoalPriority[] = held ? holdEveryGoal(computed) : computed;
	const named = held ? null : decidedLeader(rows, startsOn);
	const leader = named
		? priorities.find((p) =>
				named.ref ? p.goalId === named.ref : clip(p.title, 60) === named.title
			)
		: undefined;
	if (leader && leader.mode !== 'primary') {
		priorities = [leader, ...priorities.filter((p) => p !== leader)].map((p) => ({
			...p,
			mode: p === leader ? 'primary' : p.mode === 'primary' ? 'secondary' : p.mode
		}));
	}
	return priorities.map((p) => ({
		ref: p.goalId,
		title: p.title,
		discipline: p.disciplines[0] ?? null,
		mode: p.mode
	}));
}

const parseInput = (value: unknown): ProgrammingInput | null => {
	const input = value as ProgrammingInput | null;
	return input && Array.isArray(input.goals) && input.refs ? input : null;
};

/** The owner's road from `today`; null without an active program. */
export async function getRoadView(
	ownerId: string,
	today: IsoDate,
	deps: TrainingDeps = {}
): Promise<RoadView | null> {
	const { db } = resolveDeps(deps);
	return measure('periodisation', async () => {
		// One query at a time on the one handle (docs/architecture.md).
		const programs = createProgramsRepository(db);
		const found = await programs.currentProgram(ownerId);
		if (!found) return null;
		const { blocks, weeks } = await programs.versionOutline(found.version.id);
		const rows = await createPeriodisationRepository(db).decisionsForLineages(
			ownerId,
			found.program.id,
			blocks.map((b) => b.lineageId),
			{ kinds: MODE_KINDS, limit: MAX_MODE_DECISIONS }
		);
		const planned = await createAnalyticsRepository(db).blockInputs(found.program.id);
		const derived = rows.length === 0;

		// An outline block was drawn by the version that planned the block before it.
		let input = parseInput(planned.values().next().value);
		const road = blocks.map((block) => {
			input = parseInput(planned.get(block.lineageId)) ?? input;
			return { block, input };
		});
		const roadBlocks = road
			.filter(({ block }) => block.endsOn >= today)
			.map(({ block, input }): RoadBlock => {
				const bridge = block.phase === BRIDGE_PHASE;
				return {
					lineage: block.lineageId,
					phase: block.phase,
					label: labelOf(block.phase, input, block.goalRefs),
					startsOn: block.startsOn,
					endsOn: block.endsOn,
					outline: block.outline,
					weeks: weeks
						.filter((w) => w.blockId === block.id)
						.map((w) => ({
							startsOn: w.startsOn,
							kind: w.kind,
							current: w.startsOn <= today && today <= w.endsOn
						})),
					goals: bridge || !input ? [] : goalsOf(input, block.phase, block.startsOn, rows),
					modesNote: bridge || !derived ? null : DERIVED_MODES_NOTE
				};
			});

		const latest = road.at(-1)?.input ?? null;
		const events = (latest ? [...latest.goals, ...latest.paused] : [])
			.filter((g) => g.eventDate !== null && g.eventDate >= today)
			.map((g) => ({
				goalTitle: g.title,
				date: g.eventDate!,
				weeksAway: Math.floor(daysBetween(today, g.eventDate!) / 7)
			}))
			.toSorted((a, b) => a.date.localeCompare(b.date));

		const markers: RoadMarker[] = [];
		const thisWeek = mondayOf(today);
		for (const block of roadBlocks) {
			if (block.outline && /taper$/.test(block.phase)) {
				const week = block.startsOn < thisWeek ? thisWeek : block.startsOn;
				markers.push({ week, kind: 'taper', label: block.label });
			}
			for (const w of block.weeks) {
				const live = w.current || w.startsOn > today;
				if (live && (w.kind === 'deload' || w.kind === 'taper')) {
					markers.push({
						week: w.startsOn,
						kind: w.kind,
						label: `${WEEK_KIND_LABEL[w.kind]} week`
					});
				}
			}
		}

		const at = roadBlocks.findIndex((b) => b.startsOn <= today && today <= b.endsOn);
		const week = at < 0 ? -1 : roadBlocks[at]!.weeks.findIndex((w) => w.current);
		return {
			blocks: roadBlocks,
			events,
			markers,
			current: at < 0 ? null : { block: at, week: week < 0 ? null : week }
		};
	});
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;
const weeksIn = (b: RoadBlock) => Math.round((daysBetween(b.startsOn, b.endsOn) + 1) / 7);

function blockLine(b: RoadBlock): string {
	const facts = [`${weeksIn(b)} wk`, b.outline ? 'outline' : '', b.modesNote ?? '']
		.filter(Boolean)
		.join(', ');
	const modes = (['primary', 'secondary', 'maintenance'] as const)
		.map((mode) => {
			const titles = b.goals.filter((g) => g.mode === mode).map((g) => g.title);
			return titles.length ? `${mode}: ${titles.join(', ')}` : '';
		})
		.filter(Boolean)
		.join('; ');
	return `${b.label} ${b.startsOn}–${b.endsOn} (${facts})${modes ? `: ${modes}` : ''}.`;
}

/**
 * The road as the coach reads it, in at most ROAD_TEXT_MAX_BYTES: where today is, the events and
 * the deloads and tapers, then the blocks in order. Whatever would run over is left out, the
 * furthest blocks first, with a line saying how many and how far the road goes.
 */
export function serialiseRoad(view: RoadView): string {
	const now = view.current && view.blocks[view.current.block]!;
	const week = view.current?.week ?? null;
	const lines = [
		now
			? `Now: ${now.label}${week === null ? '' : `, week ${week + 1} of ${now.weeks.length}`}.`
			: 'Now: no block holds today.',
		view.events.length
			? `Events: ${view.events.map((e) => `${e.goalTitle} ${e.date} (${e.weeksAway} wk)`).join('; ')}.`
			: 'Events: none ahead.',
		view.markers.length
			? `Deloads and tapers: ${view.markers.map((m) => `${m.label} ${m.week}`).join('; ')}.`
			: ''
	].filter(Boolean);
	const end = view.blocks.at(-1)?.endsOn;
	const more = (count: number) => (count ? `…and ${count} more to ${end}.` : '');
	const kept: string[] = [];
	for (const [i, line] of [...lines, ...view.blocks.map(blockLine)].entries()) {
		const left = Math.max(0, view.blocks.length - Math.max(0, i + 1 - lines.length));
		const text = [...kept, line, more(left)].filter(Boolean).join('\n');
		if (byteLength(text) > ROAD_TEXT_MAX_BYTES) break;
		kept.push(line);
	}
	const shown = Math.max(0, kept.length - lines.length);
	return [...kept, more(view.blocks.length - shown)].filter(Boolean).join('\n');
}
