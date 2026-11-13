/**
 * scripts/gallery-index.ts: the gallery's file names and its contact sheet, where a screen that
 * failed shows as failed with its reason instead of failing the run.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
	NotOnMainYet,
	readRecords,
	recordOf,
	renderIndex,
	shotFileName,
	type ShotRecord
} from './gallery-index.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'gallery-index-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const captured = (
	screen: string,
	state: string,
	device: 'iphone' | 'desktop',
	theme: 'dark' | 'light'
): ShotRecord => ({
	screen,
	state,
	device,
	theme,
	status: 'captured',
	file: shotFileName({ screen, state, device, theme })
});

const missing = (n: number) => Array<string>(n).fill('missing');

/** The table's rows: their header, then each cell's class, in column order. */
function rows(html: string): string[][] {
	return [...html.matchAll(/<tr><th scope="row">(.*?)<\/th>(.*?)<\/tr>/g)].map(([, row, cells]) => [
		row!,
		...[...cells!.matchAll(/<td class="(\w+)"/g)].map((m) => m[1]!)
	]);
}

describe('shotFileName', () => {
	it('names a shot <screen>--<state>--<device>--<theme>.png', () => {
		expect(
			shotFileName({ screen: 'today', state: 'rest-day', device: 'iphone', theme: 'dark' })
		).toBe('today--rest-day--iphone--dark.png');
		expect(
			shotFileName({
				screen: 'progress',
				state: 'weekly-review',
				device: 'desktop',
				theme: 'light'
			})
		).toBe('progress--weekly-review--desktop--light.png');
	});

	it('refuses a screen or state that would break the name apart', () => {
		for (const [screen, state] of [
			['today', 'rest--day'],
			['Today', 'sessions'],
			['coach', 'with proposal'],
			['', 'empty'],
			['../profile', 'main']
		]) {
			expect(
				() => shotFileName({ screen: screen!, state: state!, device: 'iphone', theme: 'dark' }),
				`${screen}/${state}`
			).toThrow(/kebab-case/);
		}
	});
});

describe('renderIndex', () => {
	it('shows each screen and state as a row, its four device and theme shots as linked images', () => {
		const records = (['iphone', 'desktop'] as const).flatMap((device) =>
			(['dark', 'light'] as const).flatMap((theme) => [
				captured('today', 'sessions', device, theme),
				captured('train', 'week', device, theme)
			])
		);
		const html = renderIndex(records);
		expect(rows(html)).toEqual([
			['today--sessions', 'captured', 'captured', 'captured', 'captured'],
			['train--week', 'captured', 'captured', 'captured', 'captured']
		]);
		expect([...html.matchAll(/<th>([^<]+)<\/th>/g)].map((m) => m[1]).slice(1)).toEqual([
			'iphone · dark',
			'iphone · light',
			'desktop · dark',
			'desktop · light'
		]);
		expect(html).toContain(
			'<a href="today--sessions--desktop--light.png"><img src="today--sessions--desktop--light.png"'
		);
		expect(html).toContain('8 captured · 0 failed · 0 skipped · 0 not on main yet');
	});

	it('records a failed screen as failed with its reason, and a shot never run as not run', () => {
		const html = renderIndex([
			captured('coach', 'empty', 'iphone', 'dark'),
			{
				screen: 'coach',
				state: 'inbox',
				device: 'iphone',
				theme: 'dark',
				status: 'failed',
				reason: 'locator.click: Timeout 10000ms exceeded <a href="/x">'
			},
			{
				screen: 'offline',
				state: 'today',
				device: 'iphone',
				theme: 'light',
				status: 'skipped',
				reason: 'offline emulation is Chromium-only'
			}
		]);
		expect(rows(html)).toEqual([
			['coach--empty', 'captured', ...missing(3)],
			['coach--inbox', 'failed', ...missing(3)],
			['offline--today', 'missing', 'skipped', ...missing(2)]
		]);
		// The reason is shown as text, never as markup.
		expect(html).toContain('Timeout 10000ms exceeded &lt;a href=&quot;/x&quot;&gt;');
		expect(html).not.toContain('<a href="/x">');
		expect(html).toContain('offline emulation is Chromium-only');
		expect(html).toContain('1 captured · 1 failed · 1 skipped');
	});

	it('shows a screen not on main yet as not on main yet with what is missing, never as failed', () => {
		const html = renderIndex([
			captured('coach', 'empty', 'iphone', 'dark'),
			{
				screen: 'coach',
				state: 'proposals-inbox',
				device: 'iphone',
				theme: 'dark',
				status: 'absent',
				reason: 'Coach has no link to the proposals inbox yet.'
			}
		]);
		expect(rows(html)).toEqual([
			['coach--empty', 'captured', ...missing(3)],
			['coach--proposals-inbox', 'absent', ...missing(3)]
		]);
		expect(html).toContain(
			'<td class="absent"><strong>not on main yet</strong><p>Coach has no link to the proposals inbox yet.</p></td>'
		);
		expect(html).toContain('1 captured · 0 failed · 0 skipped · 1 not on main yet');
	});

	it('keeps the last record of a shot taken twice', () => {
		const failed: ShotRecord = {
			...captured('today', 'sessions', 'iphone', 'dark'),
			status: 'failed',
			reason: 'first attempt'
		};
		const html = renderIndex([failed, captured('today', 'sessions', 'iphone', 'dark')]);
		expect(rows(html)).toEqual([['today--sessions', 'captured', ...missing(3)]]);
		expect(html).not.toContain('first attempt');
		expect(html).toContain('1 captured · 0 failed');
	});
});

describe('recordOf', () => {
	const key = {
		screen: 'progress',
		state: 'cycle-review',
		device: 'desktop',
		theme: 'light'
	} as const;

	it('records NotOnMainYet as absent, with what is missing', () => {
		expect(
			recordOf(key, new NotOnMainYet('The reviews list has no cycle review to open yet.'))
		).toEqual({
			...key,
			status: 'absent',
			reason: 'The reviews list has no cycle review to open yet.'
		});
	});

	it('records any other error as failed, its colour codes stripped and its reason capped', () => {
		const esc = String.fromCharCode(27);
		expect(recordOf(key, new Error(`  ${esc}[31mlocator.click${esc}[39m: Timeout  `))).toEqual({
			...key,
			status: 'failed',
			reason: 'locator.click: Timeout'
		});
		expect(recordOf(key, 'x'.repeat(700)).reason).toHaveLength(600);
		expect(recordOf(key, 'not an error').status).toBe('failed');
	});
});

describe('node scripts/gallery-index.ts <dir>', () => {
	it('merges every device’s results into index.html beside the PNGs', () => {
		const dir = path.join(scratch, 'merge');
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		const line = (r: ShotRecord) => `${JSON.stringify(r)}\n`;
		writeFileSync(
			path.join(dir, 'results-iphone.jsonl'),
			line(captured('today', 'sessions', 'iphone', 'dark')) +
				line({
					...captured('coach', 'inbox', 'iphone', 'dark'),
					status: 'failed',
					reason: 'gone'
				}) +
				line({
					...captured('progress', 'cycle-review', 'iphone', 'dark'),
					status: 'absent',
					reason: 'not yet'
				})
		);
		writeFileSync(
			path.join(dir, 'results-desktop.jsonl'),
			line(captured('today', 'sessions', 'desktop', 'light'))
		);
		writeFileSync(
			path.join(dir, 'notes.jsonl'),
			line(captured('ignored', 'file', 'iphone', 'dark'))
		);
		expect(readRecords(dir).map((r) => `${r.screen}--${r.state}--${r.device}`)).toEqual([
			'today--sessions--desktop',
			'today--sessions--iphone',
			'coach--inbox--iphone',
			'progress--cycle-review--iphone'
		]);

		const run = spawnSync(process.execPath, ['scripts/gallery-index.ts', dir], {
			cwd: root,
			encoding: 'utf8'
		});
		expect(run.status, run.stderr).toBe(0);
		expect(run.stdout).toContain('4 shots indexed, 1 failed, 1 not on main yet');
		const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
		expect(rows(html)).toEqual([
			['today--sessions', 'captured', ...missing(2), 'captured'],
			['coach--inbox', 'failed', ...missing(3)],
			['progress--cycle-review', 'absent', ...missing(3)]
		]);
	});

	it('refuses to run without a directory', () => {
		const run = spawnSync(process.execPath, ['scripts/gallery-index.ts'], {
			cwd: root,
			encoding: 'utf8'
		});
		expect(run.status).toBe(2);
		expect(run.stderr).toContain('usage: node scripts/gallery-index.ts <dir>');
	});
});
