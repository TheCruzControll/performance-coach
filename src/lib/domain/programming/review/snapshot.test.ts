/**
 * snapshot.ts and brief.ts: the stored review contract. A v1 snapshot survives a round trip
 * through jsonb, rows of other versions read as legacy with their summary, and a broken v1 row is
 * refused at the path that breaks it.
 */
import { describe, expect, it } from 'vitest';
import { reviewBriefSchema } from './brief';
import type { ReviewBrief } from './brief';
import {
	readSnapshot,
	SNAPSHOT_VERSION,
	SnapshotError,
	weeklyReviewSnapshotSchema
} from './snapshot';
import type { WeeklyReviewSnapshot } from './snapshot';
import { validate } from '../../validation';

const brief: ReviewBrief = {
	kind: 'weekly',
	from: '2026-11-02',
	to: '2026-11-08',
	summary: '4 of 4 sessions done · bench below target twice · fatigue watch',
	findings: [
		{
			id: 'e1rm:bench',
			section: 'verdicts',
			label: 'Bench press e1RM',
			figures: [
				{ label: 'e1RM', value: 101.3, unit: 'kg', kind: 'estimated', words: '101.3 kg' },
				{ label: 'Change', value: null, unit: 'kg', kind: 'calculated', words: 'No change yet' }
			],
			verdict: { level: 'good', words: 'Trending up' },
			window: { from: '2026-08-17', to: '2026-11-08', label: 'Trend over the last 12 weeks' },
			metricId: 'e1rm',
			sources: [{ type: 'set', id: 'set-1', date: '2026-11-03', workoutId: 'w-1', label: 'Tue' }]
		},
		{
			id: 'conflict:2026-11-05',
			section: 'conflicts',
			label: 'Sparring before the long run',
			figures: [],
			verdict: { level: 'watch', words: 'Hard sparring the day before your long run' },
			window: null,
			metricId: null,
			sources: [{ type: 'date', id: '2026-11-05' }]
		}
	]
};

const snapshot: WeeklyReviewSnapshot = {
	version: 1,
	weekStartsOn: '2026-11-02',
	computedOn: '2026-11-09',
	timeZone: 'America/Los_Angeles',
	analyticsVersion: 1,
	inputsDigest: '0123456789abcdef',
	adherence: { planned: 4, completed: 3, skipped: 1, missed: 0, pct: 75 },
	fatigue: { level: 'watch', reasons: ['Soreness 4 of 5'] },
	next: { weekStartsOn: '2026-11-09', state: 'planned', kind: 'deload' },
	noProposal: null,
	brief
};

const SUMMARY = 'You did 3 of 4 sessions.';
/** As Postgres hands a jsonb column back: a fresh object, its keys in jsonb's own order. */
const stored = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
const row = (snapshotVersion: number, value: unknown = snapshot) => ({
	snapshotVersion,
	snapshot: stored(value),
	summary: SUMMARY
});

/** The path readSnapshot refuses `value` at, or null when it reads it. */
function refusedAt(value: unknown): string | null {
	try {
		readSnapshot(row(1, value));
		return null;
	} catch (error) {
		expect(error).toBeInstanceOf(SnapshotError);
		return (error as SnapshotError).path;
	}
}

describe('the v1 weekly snapshot', () => {
	it('round-trips through its schema and jsonb unchanged', () => {
		expect(SNAPSHOT_VERSION).toBe(1);
		const read = readSnapshot(row(1));
		expect(read).toEqual({ legacy: false, version: 1, summary: SUMMARY, snapshot });
		expect(validate(weeklyReviewSnapshotSchema, snapshot)).toEqual({ ok: true, data: snapshot });
	});

	it.each([0, 99])('reads version %i as legacy with the row summary', (version) => {
		// A pre-M6 row's snapshot is anything M3 stored; a newer release's is unknown here.
		expect(readSnapshot(row(version, { figures: { tonnage: 1200 } }))).toEqual({
			legacy: true,
			version,
			summary: SUMMARY
		});
	});

	it('refuses a malformed v1 snapshot with its path', () => {
		const verdict = structuredClone(snapshot);
		(verdict.brief.findings[0]!.verdict as { level: string }).level = 'great';
		expect(refusedAt(verdict)).toBe('brief.findings.0.verdict.level');

		expect(refusedAt({ ...snapshot, version: 2 })).toBe('version');
		expect(refusedAt({ ...snapshot, inputsDigest: 'xyz' })).toBe('inputsDigest');
		expect(refusedAt({ ...snapshot, extra: true })).toBe('');
		expect(refusedAt({ ...snapshot, weekStartsOn: '2026-11-03' })).toBe('weekStartsOn');
		expect(refusedAt({ ...snapshot, weekStartsOn: 'bad' })).toBe('weekStartsOn');
		expect(refusedAt({ ...snapshot, weekStartsOn: '2026-02-30' })).toBe('weekStartsOn');
		expect(refusedAt({ ...snapshot, next: { ...snapshot.next, weekStartsOn: '2026-11-16' } })).toBe(
			'next.weekStartsOn'
		);
		expect(refusedAt({ ...snapshot, brief: { ...brief, kind: 'cycle' } })).toBe('brief');
		expect(refusedAt('not an object')).toBe('');

		const unit = structuredClone(snapshot);
		(unit.brief.findings[0]!.figures[0] as { unit: string }).unit = 'lb';
		expect(refusedAt(unit)).toBe('brief.findings.0.figures.0.unit');

		expect(() => readSnapshot(row(1, { ...snapshot, adherence: null }))).toThrow(
			/breaks its contract at adherence/
		);
	});
});

describe('the findings brief', () => {
	it('refuses a long summary, a repeated id, a reversed range and an unknown metric', () => {
		const errors = (value: ReviewBrief) => {
			const checked = validate(reviewBriefSchema, value);
			return checked.ok ? {} : checked.errors;
		};
		expect(errors({ ...brief, summary: 'x'.repeat(201) })).toHaveProperty('summary');
		expect(errors({ ...brief, summary: 'x'.repeat(200) })).toEqual({});
		expect(errors({ ...brief, findings: [brief.findings[0]!, brief.findings[0]!] })).toHaveProperty(
			'findings'
		);
		expect(errors({ ...brief, to: '2026-11-01' })).toHaveProperty('to');
		const metric = structuredClone(brief);
		(metric.findings[0] as { metricId: string }).metricId = 'vo2max';
		expect(errors(metric)).toHaveProperty(['findings.0.metricId']);
		const value = structuredClone(brief);
		value.findings[0]!.figures[0]!.value = Number.NaN;
		expect(errors(value)).toHaveProperty(['findings.0.figures.0.value']);
	});
});
