/**
 * The journey map (e2e/journeys.ts, M9 acceptance 3): its rules on fixture listings, then the
 * real map against the PRD's lists and against `playwright test --list`. Lenient by default;
 * STRICT=1 (journeys-complete) also fails on a missing title and on anything still pending.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COACH_PRD, JOURNEYS, PERSISTENCE, type JourneyEntry } from '../e2e/journeys.ts';
import { checkJourneyMap, listSuite, parseListing, prdItems } from './journey-map.ts';

const root = new URL('../', import.meta.url);
const STRICT = process.env.STRICT === '1';

/** A listing in Playwright's JSON shape: one file, a describe, and the projects of each test. */
const listing = parseListing({
	config: { projects: [{ name: 'iphone-chromium' }, { name: 'iphone-webkit' }] },
	suites: [
		{
			title: 'workout.e2e.ts',
			file: 'workout.e2e.ts',
			specs: [
				{
					title: 'logs a set',
					tests: [{ projectName: 'iphone-chromium' }, { projectName: 'iphone-webkit' }]
				}
			],
			suites: [
				{
					title: 'offline',
					file: 'workout.e2e.ts',
					specs: [{ title: 'reloads the shell', tests: [{ projectName: 'iphone-chromium' }] }]
				}
			]
		}
	]
});

const BOTH = ['iphone-chromium', 'iphone-webkit'];
const mapped = (over: Record<string, unknown> = {}) =>
	({
		id: 'log-sets',
		prd: '§19: log sets/reps/RPE',
		projects: BOTH,
		tests: [{ file: 'workout.e2e.ts', title: 'logs a set' }],
		...over
	}) as JourneyEntry;
const offlineReload = { file: 'workout.e2e.ts', title: 'offline › reloads the shell' };

describe('the journey map rules', () => {
	it('passes a mapped entry whose title runs in every required project, in both modes', () => {
		for (const strict of [false, true]) {
			expect(checkJourneyMap([mapped()], listing, { strict })).toEqual({
				errors: [],
				mismatches: []
			});
		}
	});

	it('fails on a pending id that is not a proving slice, even when lenient', () => {
		const { errors } = checkJourneyMap(
			[{ id: 'rest-timer', prd: '§19: rest timer', pending: 'journey-strenght' }],
			listing
		);
		expect(errors).toEqual([
			'rest-timer: pending names "journey-strenght", which is not a proving slice'
		]);
	});

	it('lets a real pending id through when lenient, and fails it in strict mode', () => {
		const pending = { id: 'rest-timer', prd: '§19: rest timer', pending: 'journey-strength' };
		expect(checkJourneyMap([pending], listing).errors).toEqual([]);
		expect(checkJourneyMap([pending], listing, { strict: true }).errors).toEqual([
			'rest-timer: is still pending journey-strength'
		]);
	});

	it('reports a title missing from a required project, and fails it in strict mode, naming both', () => {
		const entry = mapped({ tests: [offlineReload] });
		const why =
			'log-sets: iphone-webkit does not run "workout.e2e.ts › offline › reloads the shell"';
		expect(checkJourneyMap([entry], listing)).toEqual({ errors: [], mismatches: [why] });
		expect(checkJourneyMap([entry], listing, { strict: true }).errors).toEqual([why]);
	});

	it('reports a title in no project at all, and a project the config does not have', () => {
		const entry = mapped({
			projects: ['iphone-chromium', 'desktop-chromium'],
			tests: [{ file: 'workout.e2e.ts', title: 'logs a sett' }]
		});
		expect(checkJourneyMap([entry], listing, { strict: true }).errors).toEqual([
			'log-sets: iphone-chromium does not run "workout.e2e.ts › logs a sett"',
			'log-sets: no project desktop-chromium in the Playwright config'
		]);
	});

	it('excuses a project with a reasoned gap, but never one without a reason', () => {
		const gapped = (reason: string) =>
			mapped({ tests: [offlineReload], gaps: [{ project: 'iphone-webkit', reason }] });
		expect(
			checkJourneyMap([gapped('Playwright cannot emulate offline for WebKit')], listing, {
				strict: true
			})
		).toEqual({ errors: [], mismatches: [] });
		expect(checkJourneyMap([gapped('  ')], listing).errors).toEqual([
			'log-sets: the gap for iphone-webkit has no reason'
		]);
	});

	it('fails a gap for a project no test of the entry requires', () => {
		const entry = mapped({ gaps: [{ project: 'setup', reason: 'not needed' }] });
		expect(checkJourneyMap([entry], listing).errors).toEqual([
			'log-sets: a gap names setup, which no test of it requires'
		]);
	});

	it('checks a test against its own projects instead of the entry’s', () => {
		const entry = mapped({ tests: [{ ...offlineReload, projects: ['iphone-chromium'] }] });
		expect(checkJourneyMap([entry], listing, { strict: true }).errors).toEqual([]);
	});

	it('fails malformed and duplicate entries, even when lenient', () => {
		const { errors } = checkJourneyMap(
			[
				mapped({ prd: '' }),
				mapped({ id: 'no-tests', tests: [] }),
				mapped({ id: 'no-projects', projects: [] }),
				mapped({ id: 'bad-test', tests: [{ file: 'workout.e2e.ts' }] }),
				mapped({ id: 'pending-and-tests', pending: 'journey-strength' }),
				mapped({ id: 'dup' }),
				mapped({ id: 'dup' })
			],
			listing
		);
		expect(errors).toEqual([
			'log-sets: needs an id and its PRD wording',
			'no-tests: needs projects and at least one test, or a pending slice',
			'no-projects: needs projects and at least one test, or a pending slice',
			'bad-test: every test needs a file, a title and, if given, its projects',
			'pending-and-tests: is pending, so it lists no tests, projects or gaps',
			'dup: appears twice'
		]);
	});

	it('reads both lists from the PRD, item by item', () => {
		const prd = [
			'## 18. Persistence verification',
			'',
			'Test: refresh mid-workout; close/reopen.',
			'## 19. Testing philosophy',
			'Playwright journeys: login via supported auth test flow; onboarding;',
			'rest timer. iPhone-sized viewports.',
			'## 20. Repository'
		].join('\n');
		expect(prdItems(prd)).toEqual([
			'§19: login via supported auth test flow',
			'§19: onboarding',
			'§19: rest timer',
			'§18: refresh mid-workout',
			'§18: close/reopen'
		]);
	});
});

describe('the real journey map', () => {
	const entries = [...JOURNEYS, ...PERSISTENCE];

	it('holds exactly every PRD §19 journey, the coach journey and every §18 case', () => {
		const prd = readFileSync(new URL('docs/product-requirements.md', root), 'utf8');
		expect(entries.map((e) => e.prd).sort()).toEqual([...prdItems(prd), COACH_PRD].sort());
	});

	it(`passes against the Playwright listing (${STRICT ? 'strict' : 'lenient'})`, () => {
		const report = checkJourneyMap(entries, listSuite(fileURLToPath(root)), { strict: STRICT });
		for (const mismatch of report.mismatches) console.warn(`journey map: ${mismatch}`);
		expect(report.errors).toEqual([]);
	}, 120_000);
});
