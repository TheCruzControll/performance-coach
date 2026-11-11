/**
 * The next block as a cycle review's card shows it (NextCycleCard.svelte), arranged on the server
 * from getCycleReviewView's previews (one per start on offer, the default first) and the review's
 * decision, so the card computes nothing:
 *
 * - open (undecided, with a preview): per start its label and when it starts ('Starts today,
 *   Wednesday'), the block's phase, weeks and dates, a late start's unplanned bridge ('Weeks 12–14
 *   stay unplanned') and what it costs before an event ('Your build is 3 weeks shorter before the
 *   race'), week 1 as a WeekStrip with each day's sessions, and its decisions grouped: what changes
 *   and why (the significant changes), the exercises kept and rotated, the starting loads
 *   (labelled estimated when they come from an e1RM), and the targets and deload
 * - the overrides: each rotated exercise to keep instead, and the deload moved or skipped
 * - folded: the head is a revision of the review's own proposal, which only a coach's next_cycle
 *   folded in makes while it is undecided ('Includes your coach’s suggestion')
 * - applied, decided elsewhere (rejected from M5's inbox), superseded: what happened, and where
 *   to go
 */
import { addDays, daysBetween, weekdayOf, type IsoDate } from '#lib/domain/calendar.ts';
import { WEEKDAY_INFO } from '#lib/domain/weekdays.ts';
import type { NextBlockStart } from '#lib/domain/programming/next-block/dates.ts';
import type { DeloadPlacement } from '#lib/domain/programming/review/directives.ts';
import { directivesFrom } from '#lib/domain/programming/review/directives.ts';
import { PHASE_LABEL } from '#lib/domain/training/vocabulary.ts';
import { PLAN_OVERVIEW_HREF } from '#lib/server/forms/reviews.ts';
import type { CycleReviewView, NextBlockPreview } from '#lib/server/services/reviews/index.ts';
import {
	cardView,
	shortDate,
	stripDay,
	type CardView,
	type StripDayView
} from '#lib/ui/program/words.ts';

export const START_LABEL: Record<NextBlockStart, string> = {
	this_week: 'This week',
	next_monday: 'Next Monday'
};

/** Where the card links once the block is planned: Train with the plan overview open. */
export const PLAN_LINK = { href: PLAN_OVERVIEW_HREF, label: 'Open your plan' };

/** The deload choice that leaves it where the rules put it. */
export const DELOAD_AS_PLANNED = 'planned';

export interface NextCycleItem {
	label: string;
	words: string;
	/** 'Estimated': a starting load from an estimated 1RM. */
	badge: string | null;
}

export interface NextCyclePreviewView {
	start: NextBlockStart;
	label: string;
	/** 'Starts today, Wednesday' or 'Starts Mon 23 Nov'. */
	hint: string;
	fingerprint: string;
	/** 'Build · Intensification'. */
	title: string;
	/** 'Mon 23 Nov – Sun 20 Dec · 4 weeks'. */
	dates: string;
	/** What a late start costs: the bridge, then the weeks lost before an event. */
	notes: { id: 'bridge' | 'lost'; words: string }[];
	week: {
		days: StripDayView[];
		/** The owner's today when it falls in week 1. */
		today: IsoDate | null;
		/** The first day it plans, which the strip opens on. */
		first: IsoDate;
		/** Each session as a SessionCard lays it out. */
		sessions: (CardView & { date: IsoDate })[];
	};
	groups: {
		id: 'changes' | 'exercises' | 'loads' | 'targets';
		title: string;
		items: NextCycleItem[];
	}[];
}

export interface NextCycleView {
	state: 'open' | 'applied' | 'decided_elsewhere' | 'superseded';
	title: string;
	words: string | null;
	/** A coach's next_cycle was folded into the head. */
	folded: boolean;
	previews: NextCyclePreviewView[];
	/** The exercises the rules rotate, each of which the owner may keep instead (by library id). */
	rotated: { value: string; label: string; hint: string }[];
	/** The deload's choices, the rules' place first; null when the block has none. */
	deload: { value: string; label: string }[] | null;
	link: { href: string; label: string } | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where the block's deload falls: its first week, its last, or none. */
export function deloadPlacement(preview: NextBlockPreview): DeloadPlacement {
	const kinds = preview.block.weeks.map((w) => w.kind);
	if (kinds[0] === 'deload') return 'first';
	return kinds.length > 1 && kinds.at(-1) === 'deload' ? 'last' : 'none';
}

/** The deload's choices: as planned, moved to the other end, or skipped. */
function deloadChoices(placement: DeloadPlacement, weeks: number) {
	if (placement === 'none') return null;
	const week = placement === 'first' ? 1 : weeks;
	const other = placement === 'first' ? 'last' : 'first';
	return [
		{ value: DELOAD_AS_PLANNED, label: `As planned · week ${week}` },
		{ value: other, label: `Move it to the ${other} week` },
		{ value: 'none', label: 'Skip the deload' }
	];
}

/** When a start's block starts, in words. */
function startHint(p: NextBlockPreview, today: IsoDate): string {
	const first = p.dates.firstPlannedDay;
	if (first === today) return `Starts today, ${WEEKDAY_INFO[weekdayOf(today)].label}`;
	return `Starts ${shortDate(first)}`;
}

/** A late start's bridge and lost weeks, counted in the program's weeks when its start is known. */
function notesOf(p: NextBlockPreview, programStartsOn: IsoDate | null) {
	const notes: NextCyclePreviewView['notes'] = [];
	const bridge = p.dates.bridge;
	if (bridge) {
		const from = programStartsOn && daysBetween(programStartsOn, bridge.startsOn) / 7 + 1;
		const words = !from
			? `${plural(bridge.weeks, 'week')} between blocks stay unplanned`
			: bridge.weeks === 1
				? `Week ${from} stays unplanned`
				: `Weeks ${from}–${from + bridge.weeks - 1} stay unplanned`;
		notes.push({ id: 'bridge', words });
	}
	if (p.dates.lostWeeks > 0)
		notes.push({
			id: 'lost',
			words: `Your build is ${plural(p.dates.lostWeeks, 'week')} shorter before the race`
		});
	return notes;
}

/** Week 1 as a WeekStrip lays it out, with each day's sessions as SessionCards do. */
function weekOf(p: NextBlockPreview, today: IsoDate): NextCyclePreviewView['week'] {
	const week = p.block.weeks[0]!;
	const inWeek = today >= week.startsOn && today <= week.endsOn ? today : null;
	const days = Array.from({ length: 7 }, (_, i) => {
		const date = addDays(week.startsOn, i);
		const sessions = week.sessions
			.filter((s) => s.date === date)
			.map((s) => ({ type: s.type, status: 'planned' as const }));
		return stripDay({ date, weekday: weekdayOf(date), sessions }, inWeek);
	});
	return {
		days,
		today: inWeek,
		first: p.dates.firstPlannedDay,
		sessions: week.sessions.map((s) => ({
			date: s.date,
			...cardView({ ...s, status: 'planned', movedFrom: null })
		}))
	};
}

/** The preview's decisions in the card's groups, each in the generator's order. */
function groupsOf(
	p: NextBlockPreview,
	targets: readonly NextCycleItem[]
): NextCyclePreviewView['groups'] {
	const item = (d: { summary: string; why: string }, badge: string | null = null) => ({
		label: d.summary,
		words: d.why,
		badge
	});
	const significant = [...new Set(p.significantChanges.map((c) => c.decision))];
	const changes = significant.flatMap((i) => (p.decisions[i] ? [item(p.decisions[i])] : []));
	const of = (...kinds: string[]) => p.decisions.filter((d) => kinds.includes(d.kind));
	const deload = of('deload_scheduled');
	return [
		{
			id: 'changes',
			title: 'What changes and why',
			items: changes.length
				? changes
				: [
						{
							label: 'Nothing changes much',
							words: 'The block carries on from this one, with its loads moved by your results.',
							badge: null
						}
					]
		},
		{
			id: 'exercises',
			title: 'Exercises',
			items: of('exercise_kept', 'exercise_rotated').map((d) => item(d))
		},
		{
			id: 'loads',
			title: 'Starting loads',
			items: of('load_basis').map((d) =>
				item(d, d.ruleKey === 'loads.estimated' ? 'Estimated' : null)
			)
		},
		{
			id: 'targets',
			title: 'Targets and deload',
			items: [
				...targets,
				...(deload.length
					? deload.map((d) => item(d))
					: [{ label: 'No deload', words: 'This block has no deload week.', badge: null }])
			]
		}
	].filter((g) => g.items.length) as NextCyclePreviewView['groups'];
}

/** The card's words for a decided review. */
const DECIDED = {
	applied: {
		title: 'Next block planned',
		words: 'It’s in your plan as a new version. Earlier versions stay in History.'
	},
	decided_elsewhere: {
		title: 'Next block not planned',
		words: 'You turned it down from your coach inbox, so your plan stays as it is.'
	},
	superseded: {
		title: 'Your plan changed since this review',
		words: 'A newer plan replaced this next block, so nothing from it was applied.'
	}
} as const;

/**
 * The cycle review's next-block card on the owner's `today`; `programStartsOn` numbers a bridge's
 * weeks. Null for a review written before M6, or with no next block to decide.
 */
export function nextCycleView(
	view: CycleReviewView,
	{ today, programStartsOn }: { today: IsoDate; programStartsOn: IsoDate | null }
): NextCycleView | null {
	const { snapshot, decision, proposal } = view;
	if (view.legacy || !snapshot) return null;
	const card = (
		state: NextCycleView['state'],
		more: Partial<NextCycleView> = {}
	): NextCycleView => ({
		state,
		...(state === 'open' ? { title: 'Your next block', words: null } : DECIDED[state]),
		folded: false,
		previews: [],
		rotated: [],
		deload: null,
		link: null,
		...more
	});
	switch (decision.state) {
		case 'applied': {
			const n = decision.versionNumber;
			return card('applied', {
				title: n === null ? DECIDED.applied.title : `Next block planned · version ${n}`,
				link: PLAN_LINK
			});
		}
		case 'rejected':
			return card('decided_elsewhere', {
				words: proposal?.decisionNote ?? DECIDED.decided_elsewhere.words
			});
		case 'superseded':
			return card('superseded');
		case 'undecided':
			break;
		default:
			return null;
	}
	if (!view.previews.length) return null;
	// The head's brief (M5's rows): its emphasis, targets, running, ending and constraints.
	const targets = (proposal?.rows ?? [])
		.filter((r) => r.after && !['Next block', 'Focus'].includes(r.label))
		.map((r) => ({ label: r.label, words: r.after!, badge: null }));
	const names = new Map(
		snapshot.brief.findings.map((f) => [f.id, f.label.replace(/ \(main lift\)$/, '')])
	);
	const { rotate } = directivesFrom({ snapshot, running: null }, null, []);
	const first = view.previews[0]!;
	return card('open', {
		folded: proposal?.revisionOf != null,
		previews: view.previews.map((p) => ({
			start: p.start,
			label: START_LABEL[p.start],
			hint: startHint(p, today),
			fingerprint: p.fingerprint,
			title: [p.block.name, PHASE_LABEL[p.block.phase]].filter(Boolean).join(' · '),
			dates: `${shortDate(p.block.startsOn)} – ${shortDate(p.block.endsOn)} · ${plural(p.block.weeks.length, 'week')}`,
			notes: notesOf(p, programStartsOn),
			week: weekOf(p, today),
			groups: groupsOf(p, targets)
		})),
		rotated: rotate.map((r) => ({
			value: r.exercise,
			label: `Keep ${names.get(`effectiveness:${r.exercise}`) ?? 'this exercise'}`,
			hint: r.reason
		})),
		deload: deloadChoices(deloadPlacement(first), first.block.weeks.length)
	});
}
