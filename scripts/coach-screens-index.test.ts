/**
 * The coach's screenshot set (e2e/coach-screens.ts) and its contact sheet
 * (scripts/coach-screens-index.ts): every designed state names a capture at both viewports, taken
 * by a spec that really takes it; the sheet places each capture, lists what a run lacks, and keeps
 * every other coach capture.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { COACH_SCREENS, JOURNEY_SPEC, type CoachScreen } from '../e2e/coach-screens.ts';
import { planIndex, readCaptures, renderIndex } from './coach-screens-index.ts';

const E2E = path.resolve(import.meta.dirname, '../e2e');
const source = (spec: string) => readFileSync(path.join(E2E, spec), 'utf8');

/** Does `spec` take capture `name`: as a quoted literal, or by a template literal that matches it? */
function takes(spec: string, name: string): boolean {
	const text = source(spec);
	if (text.includes(`'${name}'`) || text.includes(`\`${name}\``)) return true;
	const templates = [...text.matchAll(/`(coach-[^`]*\$\{[^`]*)`/g)].map((m) => m[1]!);
	return templates.some((template) => {
		const parts = template.split(/\$\{[^}]*\}/).map((p) => p.replace(/[.*+?^$()|[\]\\]/g, '\\$&'));
		return new RegExp(`^${parts.join('[\\w-]+')}$`).test(name);
	});
}

/**
 * Does the journey spec shoot screen `id`: in a shoot() call, or as an entry of SHEET_STATES, whose
 * loop shoots each.
 */
function shoots(id: string): boolean {
	const text = source(JOURNEY_SPEC);
	const sheets = /const SHEET_STATES = \{([^}]*)\}/.exec(text)?.[1] ?? '';
	return text.includes(`shoot(page, testInfo, '${id}'`) || sheets.includes(`'${id}'`);
}

describe('the designed states', () => {
	it('names every state once, each with a capture at 393 × 659 and one at 1440 × 900', () => {
		const ids = COACH_SCREENS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		const names = COACH_SCREENS.flatMap((s) => [s.phone.name, s.desktop.name]);
		expect(new Set(names).size, 'no capture stands for two viewports or two states').toBe(
			names.length
		);
		for (const screen of COACH_SCREENS as readonly CoachScreen[]) {
			for (const viewport of [screen.phone, screen.desktop]) {
				expect(viewport.name, screen.id).toMatch(/^coach-[a-z0-9_-]+$/);
				expect(viewport.by, screen.id).toMatch(/\.e2e\.ts$/);
			}
			expect(screen.desktop.name, `${screen.id}: the desktop capture is its own`).toMatch(
				/-desktop$/
			);
			expect(
				screen.phone.name,
				`${screen.id}: the iPhone capture is not a desktop one`
			).not.toMatch(/-desktop$/);
		}
	});

	it('covers PRD §16’s outages, long and cut-short answers, the loading, failed and empty states, and the eight journeys', () => {
		const groups = new Map<string, number>();
		for (const s of COACH_SCREENS) groups.set(s.group, (groups.get(s.group) ?? 0) + 1);
		expect([...groups.keys()]).toEqual([
			'The M5 journeys',
			'Outages',
			'Answers',
			'Loading',
			'Failures',
			'Empty'
		]);
		const journeys = COACH_SCREENS.filter((s) => s.group === 'The M5 journeys');
		expect(new Set(journeys.map((s) => s.label.split('.')[0]))).toEqual(
			new Set(['1', '2', '3', '4', '5', '6', '7', '8'])
		);
		const outages = COACH_SCREENS.filter((s) => s.group === 'Outages').map((s) => s.id);
		for (const state of ['not-launched', 'disabled', 'unavailable', 'rate-limited', 'budget'])
			expect(outages).toContain(state);
		for (const state of ['refused', 'busy', 'timeout', 'offline']) expect(outages).toContain(state);
		// The brief names long answers among the designed states.
		expect(COACH_SCREENS.map((s) => s.id)).toContain('long-answer');
	});

	it('names, for each capture, the spec that takes it', () => {
		const untaken: string[] = [];
		for (const screen of COACH_SCREENS as readonly CoachScreen[])
			for (const { name, by } of [screen.phone, screen.desktop]) {
				const taken = by === JOURNEY_SPEC ? shoots(screen.id) : takes(by, name);
				if (!taken) untaken.push(`${name} (${by})`);
			}
		expect(untaken).toEqual([]);
	});

	it('counts a journey capture only where the spec shoots it, not where it names the id', () => {
		expect(shoots('thread-loading')).toBe(true);
		expect(shoots('memory-loading')).toBe(true);
		// Named as setCoachFault's fault, never shot: coach-states.serial.e2e.ts takes it.
		expect(source(JOURNEY_SPEC)).toContain("setCoachFault(request, 'unavailable')");
		expect(shoots('unavailable')).toBe(false);
	});

	it('reads a template literal as the captures it can name, and nothing else', () => {
		expect(takes('coach-states.serial.e2e.ts', 'coach-state-budget-desktop')).toBe(true);
		expect(takes('coach-states.serial.e2e.ts', 'coach-memory-panel-loading')).toBe(false);
		expect(takes('coach-memory-panel.serial.e2e.ts', 'coach-memory-panel-loading')).toBe(true);
		expect(takes('coach-memory-panel.serial.e2e.ts', 'coach-memory-panel-loading-desktop')).toBe(
			false
		);
	});
});

const screen = (id: string, phone: string, desktop: string): CoachScreen => ({
	id,
	group: 'Outages',
	label: `The ${id} state`,
	phone: { name: phone, by: 'a.e2e.ts' },
	desktop: { name: desktop, by: 'a.e2e.ts' }
});
const SCREENS = [
	screen('budget', 'coach-budget', 'coach-budget-desktop'),
	screen('busy', 'coach-busy', 'coach-busy-desktop')
];

describe('the contact sheet', () => {
	it('lists a state a project captured at one viewport only as missing the other', () => {
		const plan = planIndex(
			new Map([
				[
					'serial-webkit',
					new Set(['coach-budget', 'coach-budget-desktop', 'coach-busy', 'coach-extra'])
				],
				[
					'serial-chromium',
					new Set(['coach-budget', 'coach-budget-light', 'coach-budget-desktop', 'coach-busy'])
				]
			]),
			SCREENS
		);
		expect(plan.missing).toEqual([
			'serial-chromium: coach-busy-desktop',
			'serial-webkit: coach-busy-desktop'
		]);
		const [chromium, webkit] = plan.projects;
		expect(chromium!.project).toBe('serial-chromium');
		expect(chromium!.rows[0]).toEqual({
			screen: SCREENS[0],
			phone: {
				dark: 'serial-chromium/coach-budget.png',
				light: 'serial-chromium/coach-budget-light.png'
			},
			desktop: { dark: 'serial-chromium/coach-budget-desktop.png', light: null }
		});
		expect(chromium!.rows[1]!.desktop).toEqual({ dark: null, light: null });
		// A light capture belongs to its screen; anything else the run captured is still shown.
		expect(chromium!.others).toEqual([]);
		expect(webkit!.others).toEqual(['coach-extra']);
	});

	it('is complete when every screen has both viewports', () => {
		const names = new Set(SCREENS.flatMap((s) => [s.phone.name, s.desktop.name]));
		expect(planIndex(new Map([['serial-chromium', names]]), SCREENS).missing).toEqual([]);
	});

	it('shows each state’s captures side by side, the gaps and the other captures', () => {
		const html = renderIndex(
			planIndex(
				new Map([
					['serial-chromium', new Set(['coach-budget', 'coach-budget-desktop', 'coach-x'])]
				]),
				[...SCREENS, screen('a<b', 'coach-a', 'coach-a-desktop')]
			)
		);
		expect(html).toContain('<img src="serial-chromium/coach-budget.png" alt="393 × 659, dark"');
		expect(html).toContain(
			'<img src="serial-chromium/coach-budget-desktop.png" alt="1440 × 900, dark"'
		);
		expect(html).toContain('1440 × 900, dark: not captured');
		expect(html).toContain('Missing (4): serial-chromium: coach-busy');
		expect(html).toContain('Other coach captures');
		expect(html).toContain('serial-chromium/coach-x.png');
		expect(html).toContain('The a&lt;b state');
		expect(html).not.toContain('The a<b state');
	});
});

describe('reading a run’s screenshots', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'coach-screens-'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('takes each project’s coach PNGs by name, and skips projects with none', () => {
		mkdirSync(path.join(dir, 'serial-chromium'));
		mkdirSync(path.join(dir, 'iphone-chromium'));
		for (const file of [
			'coach-budget.png',
			'coach-budget-desktop.png',
			'design-coach-answer.png',
			'today.png',
			'coach-notes.txt'
		])
			writeFileSync(path.join(dir, 'serial-chromium', file), '');
		writeFileSync(path.join(dir, 'iphone-chromium', 'today.png'), '');
		writeFileSync(path.join(dir, 'coach-index.html'), '');
		expect(readCaptures(dir)).toEqual(
			new Map([['serial-chromium', new Set(['coach-budget', 'coach-budget-desktop'])]])
		);
		expect(readCaptures(path.join(dir, 'nowhere'))).toEqual(new Map());
	});
});
