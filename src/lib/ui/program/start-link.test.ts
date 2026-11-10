import { describe, expect, it } from 'vitest';
import { resumeLink, startLink, type StartLink } from './start-link';

const L = '0f6b1c1e-4a7d-4b8e-9c2a-000000000021';
const W = '0f6b1c1e-4a7d-4b8e-9c2a-000000000001';
const start: StartLink = {
	id: 'start-workout',
	label: 'Start workout',
	href: `/workout?start=${L}`,
	icon: 'play'
};

describe('startLink', () => {
	it('starts a planned session, or one moved to its day, through /workout?start=', () => {
		expect(startLink({ lineage: L, status: 'planned' })).toEqual(start);
		expect(startLink({ lineage: L, status: 'moved' })).toEqual(start);
		expect(startLink({ lineage: 'a b/c', status: 'planned' })?.href).toBe(
			'/workout?start=a%20b%2Fc'
		);
	});

	it('opens a completed session’s workout in History, or History when it is not found', () => {
		const done = { id: 'done-workout', label: 'Done · View', icon: 'check' } as const;
		expect(startLink({ lineage: L, status: 'completed' }, W)).toEqual({
			...done,
			href: `/progress/workouts/${W}`
		});
		expect(startLink({ lineage: L, status: 'completed' })).toEqual({
			...done,
			href: '/progress/workouts'
		});
	});

	it('offers nothing on a skipped session', () => {
		expect(startLink({ lineage: L, status: 'skipped' }, W)).toBeNull();
	});
});

describe('resumeLink', () => {
	const run = { plannedLineage: L, href: '/workout/run' };

	it('resumes the device’s workout in progress at its page when it is this session’s', () => {
		const resume = { id: 'resume-workout', label: 'Resume', href: '/workout/run', icon: 'play' };
		expect(resumeLink(L, start, run)).toEqual(resume);
		const done = startLink({ lineage: L, status: 'completed' }, W);
		expect(resumeLink(L, done, run)).toEqual(resume);
	});

	it('keeps the link for another session, an ad-hoc workout, none, or a session with no way in', () => {
		expect(resumeLink('another', start, run)).toBe(start);
		expect(resumeLink(L, start, { plannedLineage: null, href: '/workout' })).toBe(start);
		expect(resumeLink(L, start, null)).toBe(start);
		expect(resumeLink(L, null, run)).toBeNull();
	});
});
