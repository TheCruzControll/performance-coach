import { describe, expect, it } from 'vitest';
import type { MemorySnapshot } from '#lib/domain/coach/memory.ts';
import { knowsView } from './knows';

const empty = (): MemorySnapshot => ({
	asOf: '2026-11-10',
	profile: {
		goals: [],
		program: null,
		recentDays: [],
		baselines: [],
		trends: [],
		preferences: [],
		equipment: [],
		injuries: [],
		avoid: []
	},
	records: {
		painReports: [],
		recoveryNotes: [],
		decisions: [],
		proposals: [],
		reviews: [],
		threadSummaries: [],
		analyses: []
	}
});

const proposal = (status: 'proposed' | 'rejected' | 'applied', id: string) => ({
	kind: 'swap_exercise',
	title: `Proposal ${id}`,
	status,
	decidedOn: status === 'proposed' ? null : '2026-11-08',
	decisionNote: status === 'rejected' ? 'Too much volume' : null,
	origin: 'coach' as const,
	review: null,
	source: { type: 'proposal' as const, id }
});

function full(): MemorySnapshot {
	const snapshot = empty();
	snapshot.profile.goals = [
		{
			rank: 1,
			title: 'Run a marathon',
			targetDate: '2027-04-12',
			source: { type: 'goal', id: 'g1' }
		}
	];
	snapshot.profile.program = {
		name: 'Marathon block',
		versionNumber: 3,
		week: 2,
		weeks: 12,
		phase: 'marathon_base',
		source: { type: 'version', id: '3' }
	};
	snapshot.profile.trends = [
		{
			subject: 'Sessions a week',
			direction: 'up',
			summary: '3 to 4 sessions a week (+33.3%)',
			source: { type: 'date', id: '2026-10-06' }
		}
	];
	snapshot.profile.preferences = [
		{
			exercise: 'Bulgarian split squats',
			stance: 'dislike',
			origin: 'coach',
			reason: 'You said you dislike it.',
			source: { type: 'preference', id: 'p1' }
		}
	];
	snapshot.profile.equipment = [
		{ name: 'Barbell', source: { type: 'preference', id: 'equipment.barbell' } },
		{ name: 'Kettlebells (home)', source: { type: 'preference', id: 'equipment.kettlebells' } }
	];
	snapshot.profile.injuries = [
		{
			area: 'knee',
			severity: 'moderate',
			note: 'Old meniscus',
			source: { type: 'preference', id: 'injury.i1' }
		}
	];
	snapshot.profile.avoid = [
		{
			movement: 'Jump lunges',
			reason: 'Knee injury',
			source: { type: 'preference', id: 'injury.i1' }
		}
	];
	snapshot.records.painReports = [
		{
			date: '2026-11-09',
			exercise: 'Back squat',
			area: 'knee',
			severity: 'moderate',
			action: 'ended_workout',
			note: 'Sharp at the bottom',
			source: { type: 'pain_report', id: 'pr1', date: '2026-11-09', workoutId: 'w1' }
		}
	];
	snapshot.records.decisions = [
		{
			date: '2026-11-03',
			kind: 'deload',
			decider: 'rules',
			what: 'Lighter week 4',
			why: 'Three hard weeks in a row',
			source: { type: 'decision', id: 'd1', date: '2026-11-03' }
		}
	];
	snapshot.records.proposals = [
		proposal('proposed', 'p-wait'),
		proposal('rejected', 'p-no'),
		proposal('applied', 'p-yes')
	];
	snapshot.records.recoveryNotes = [
		{ date: '2026-11-09', text: 'slept 5 h', source: { type: 'date', id: '2026-11-09' } }
	];
	snapshot.records.threadSummaries = [
		{ date: '2026-11-07', text: 'We talked about my knee', source: { type: 'note', id: 'n1' } }
	];
	snapshot.records.analyses = [
		{ date: '2026-11-06', text: 'Squat moved well', source: { type: 'note', id: 'n2' } }
	];
	return snapshot;
}

describe('knowsView', () => {
	it('lists nothing for an owner the coach knows nothing about: the empty state', () => {
		expect(knowsView(empty())).toEqual({ asOf: '2026-11-10', sections: [] });
	});

	it('shows each section in order, in words, with Profile edit links where Profile holds it', () => {
		const view = knowsView(full());
		expect(view.sections.map((s) => [s.key, s.title, s.edit])).toEqual([
			['goals', 'Goals', 'goals'],
			['program', 'Program', null],
			['trends', 'Trends', null],
			['preferences', 'Exercise preferences', 'exercises'],
			['equipment', 'Equipment', 'equipment'],
			['injuries', 'Injuries', 'injuries'],
			['pain', 'Recent pain reports', null],
			['decisions', 'Decisions', null],
			['rejected', 'Rejected proposals', null]
		]);
		const items = Object.fromEntries(view.sections.map((s) => [s.key, s.items]));
		expect(items.goals).toEqual([
			{ title: 'Run a marathon', detail: 'Priority 1 · Target 2027-04-12', date: null, href: null }
		]);
		expect(items.program).toEqual([
			{
				title: 'Marathon block',
				detail: 'Week 2 of 12 · Marathon base · Version 3',
				date: null,
				href: '/train/history/3'
			}
		]);
		expect(items.trends![0]).toMatchObject({
			title: '3 to 4 sessions a week (+33.3%)',
			detail: 'Going up'
		});
		expect(items.preferences![0]).toMatchObject({
			title: 'Dislikes Bulgarian split squats',
			detail: 'You said you dislike it. · From Coach'
		});
		expect(items.equipment).toEqual([
			{ title: 'Barbell, Kettlebells (home)', detail: null, date: null, href: null }
		]);
		expect(items.injuries!.map((i) => [i.title, i.detail])).toEqual([
			['Knee', 'Moderate · Old meniscus'],
			['Avoid Jump lunges', 'Knee injury']
		]);
		expect(items.decisions).toEqual([
			{
				title: 'Lighter week 4',
				detail: 'Programming rules · Three hard weeks in a row',
				date: '2026-11-03',
				href: null
			}
		]);
	});

	it('lists a pain report by exercise, area, severity and day, linking to its workout in History', () => {
		const pain = knowsView(full()).sections.find((s) => s.key === 'pain')!;
		expect(pain.items).toEqual([
			{
				title: 'Back squat · Knee',
				detail: 'Moderate · Ended the workout',
				date: '2026-11-09',
				href: '/progress/workouts/w1'
			}
		]);
	});

	it('lists only rejected proposals, with the owner’s reason, each opening the inbox', () => {
		const rejected = knowsView(full()).sections.find((s) => s.key === 'rejected')!;
		expect(rejected.items).toEqual([
			{
				title: 'Proposal p-no',
				detail: 'Your reason: Too much volume',
				date: '2026-11-08',
				href: '/coach/proposals/p-no'
			}
		]);
	});

	it('never shows a conversation: no thread summary, analysis or recovery note reaches the view', () => {
		const text = JSON.stringify(knowsView(full()));
		for (const hidden of ['We talked about my knee', 'Squat moved well', 'slept 5 h'])
			expect(text).not.toContain(hidden);
		// Only the record half's pain, decisions and rejected proposals: none of them leaks in empty.
		const recordsOnly = empty();
		recordsOnly.records = full().records;
		recordsOnly.records.painReports = [];
		recordsOnly.records.decisions = [];
		recordsOnly.records.proposals = [proposal('proposed', 'p-wait')];
		expect(knowsView(recordsOnly).sections).toEqual([]);
	});
});
