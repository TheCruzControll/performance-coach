/**
 * 'What the coach knows' (PRD §4, §12): the coaching memory (services/coach/memory.ts
 * getCoachingMemory) as the memory sheet shows it, in words, section by section. Only structured
 * records reach it, never a conversation: the snapshot's thread summaries, workout analyses,
 * recovery notes, reviews and still-pending proposals stay out (KNOWS_SECTIONS lists what shows).
 * Each section the owner edits through Profile links there; a pain report links to its workout in
 * History, a rejected proposal to the inbox.
 *
 * GET /api/coach/memory builds the view on the server; the sheet imports only its types, so none
 * of this weighs on the Coach screen's JavaScript.
 */
import type { MemorySnapshot } from '#lib/domain/coach/memory.ts';
import { sourceAction, type SourceRef } from '#lib/domain/coach/sources.ts';
import { BODY_AREA_LABEL, SEVERITY_INFO, type Severity } from '#lib/domain/profile/catalog.ts';
import {
	DECIDER_LABEL,
	PHASE_LABEL,
	PREFERENCE_SOURCE_LABEL
} from '#lib/domain/training/vocabulary.ts';

/** The sections the sheet shows, in its order. An owner's choice. */
export const KNOWS_SECTIONS = [
	'goals',
	'program',
	'trends',
	'preferences',
	'equipment',
	'injuries',
	'pain',
	'decisions',
	'rejected'
] as const;
export type KnowsSectionKey = (typeof KNOWS_SECTIONS)[number];

export interface KnowsItem {
	title: string;
	detail: string | null;
	/** The day it is dated, `YYYY-MM-DD`; the sheet writes it in the owner's words. */
	date: string | null;
	/** An app path that opens the record (sourceAction), else null. */
	href: string | null;
}

export interface KnowsSection {
	key: KnowsSectionKey;
	title: string;
	/** The Profile section (/profile/<edit>) the owner changes it in, for what Profile holds. */
	edit: string | null;
	items: KnowsItem[];
}

/** What GET /api/coach/memory answers: only the sections with something in them. */
export interface KnowsView {
	asOf: string;
	sections: KnowsSection[];
}

const HEADINGS: Record<KnowsSectionKey, { title: string; edit: string | null }> = {
	goals: { title: 'Goals', edit: 'goals' },
	program: { title: 'Program', edit: null },
	trends: { title: 'Trends', edit: null },
	preferences: { title: 'Exercise preferences', edit: 'exercises' },
	equipment: { title: 'Equipment', edit: 'equipment' },
	injuries: { title: 'Injuries', edit: 'injuries' },
	pain: { title: 'Recent pain reports', edit: null },
	decisions: { title: 'Decisions', edit: null },
	rejected: { title: 'Rejected proposals', edit: null }
};

/** What the owner chose when they reported pain (M4's PAIN_ACTIONS). */
const PAIN_ACTION_WORDS: Record<string, string> = {
	stopped: 'Stopped the exercise',
	substituted: 'Swapped to a gentler option',
	ended_workout: 'Ended the workout'
};

const DIRECTION_WORDS = { up: 'Going up', down: 'Going down', flat: 'Holding steady' };

const area = (key: string | null) =>
	key === null ? null : (BODY_AREA_LABEL[key as keyof typeof BODY_AREA_LABEL] ?? key);
const severity = (key: Severity | null) => (key === null ? null : SEVERITY_INFO[key].label);
const words = (...parts: (string | null | undefined)[]) =>
	parts.filter((part) => part !== null && part !== undefined && part !== '').join(' · ') || null;

function href(source: SourceRef): string | null {
	const action = sourceAction(source);
	return action?.kind === 'link' ? action.href : null;
}

const item = (
	title: string,
	detail: string | null,
	{ date = null, link = null }: { date?: string | null; link?: SourceRef | null } = {}
): KnowsItem => ({ title, detail, date, href: link ? href(link) : null });

/** The coaching memory as the sheet shows it. */
export function knowsView({ asOf, profile, records }: MemorySnapshot): KnowsView {
	const { program } = profile;
	const items: Record<KnowsSectionKey, KnowsItem[]> = {
		goals: profile.goals.map((g) =>
			item(g.title, words(`Priority ${g.rank}`, g.targetDate && `Target ${g.targetDate}`))
		),
		program: program
			? [
					item(
						program.name,
						words(
							program.week === null
								? null
								: `Week ${program.week}${program.weeks === null ? '' : ` of ${program.weeks}`}`,
							program.phase &&
								(PHASE_LABEL[program.phase as keyof typeof PHASE_LABEL] ?? program.phase),
							`Version ${program.versionNumber}`
						),
						{ link: program.source }
					)
				]
			: [],
		trends: profile.trends.map((t) => item(t.summary, DIRECTION_WORDS[t.direction])),
		preferences: profile.preferences.map((p) =>
			item(
				`${p.stance === 'like' ? 'Likes' : 'Dislikes'} ${p.exercise}`,
				words(p.reason, `From ${PREFERENCE_SOURCE_LABEL[p.origin] ?? p.origin}`)
			)
		),
		equipment: profile.equipment.length
			? [item(profile.equipment.map((e) => e.name).join(', '), null)]
			: [],
		injuries: [
			...profile.injuries.map((i) =>
				item(area(i.area) ?? i.area, words(severity(i.severity), i.note))
			),
			...profile.avoid.map((a) => item(`Avoid ${a.movement}`, a.reason))
		],
		pain: records.painReports.map((p) =>
			item(
				words(p.exercise, area(p.area)) ?? 'Pain',
				words(severity(p.severity), PAIN_ACTION_WORDS[p.action] ?? p.action),
				{ date: p.date, link: p.source }
			)
		),
		decisions: records.decisions.map((d) =>
			item(d.what, words(DECIDER_LABEL[d.decider], d.why), { date: d.date })
		),
		rejected: records.proposals
			.filter((p) => p.status === 'rejected')
			.map((p) =>
				item(p.title, p.decisionNote && `Your reason: ${p.decisionNote}`, {
					date: p.decidedOn,
					link: p.source
				})
			)
	};
	return {
		asOf,
		sections: KNOWS_SECTIONS.filter((key) => items[key].length > 0).map((key) => ({
			key,
			...HEADINGS[key],
			items: items[key]
		}))
	};
}
