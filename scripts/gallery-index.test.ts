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
import { readRecords, renderIndex, shotFileName, type ShotRecord } from './gallery-index.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'gallery-index-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const captured = (
	screen: string,
	state: string,
	device: 'iphone' | 'desktop',
	theme: 'dark' | 'light',
	design: 'current' | 'graphite' = 'current'
): ShotRecord => ({
	screen,
	state,
	device,
	design,
	theme,
	status: 'captured',
	file: shotFileName({ screen, state, device, design, theme })
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
	it('names a shot <screen>--<state>--<device>--<design>--<theme>.png', () => {
		expect(
			shotFileName({
				screen: 'today',
				state: 'rest-day',
				device: 'iphone',
				design: 'current',
				theme: 'dark'
			})
		).toBe('today--rest-day--iphone--current--dark.png');
		expect(
			shotFileName({
				screen: 'progress',
				state: 'weekly-review',
				device: 'desktop',
				design: 'graphite',
				theme: 'light'
			})
		).toBe('progress--weekly-review--desktop--graphite--light.png');
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
				() =>
					shotFileName({
						screen: screen!,
						state: state!,
						device: 'iphone',
						design: 'current',
						theme: 'dark'
					}),
				`${screen}/${state}`
			).toThrow(/kebab-case/);
		}
	});
});

describe('renderIndex', () => {
	it('shows each screen and state as a row, its eight device, design and theme shots as linked images', () => {
		const records = (['iphone', 'desktop'] as const).flatMap((device) =>
			(['current', 'graphite'] as const).flatMap((design) =>
				(['dark', 'light'] as const).flatMap((theme) => [
					captured('today', 'sessions', device, theme, design),
					captured('train', 'week', device, theme, design)
				])
			)
		);
		const html = renderIndex(records);
		const all = Array<string>(8).fill('captured');
		expect(rows(html)).toEqual([
			['today--sessions', ...all],
			['train--week', ...all]
		]);
		// Each device's two designs side by side, so the owner compares a screen across them.
		expect([...html.matchAll(/<th>([^<]+)<\/th>/g)].map((m) => m[1]).slice(1)).toEqual([
			'iphone · current · dark',
			'iphone · current · light',
			'iphone · graphite · dark',
			'iphone · graphite · light',
			'desktop · current · dark',
			'desktop · current · light',
			'desktop · graphite · dark',
			'desktop · graphite · light'
		]);
		expect(html).toContain(
			'<a href="today--sessions--desktop--graphite--light.png"><img src="today--sessions--desktop--graphite--light.png"'
		);
		expect(html).toContain('16 captured · 0 failed · 0 skipped');
	});

	it('records a failed screen as failed with its reason, and a shot never run as not run', () => {
		const html = renderIndex([
			captured('coach', 'empty', 'iphone', 'dark'),
			{
				screen: 'coach',
				state: 'inbox',
				device: 'iphone',
				design: 'current',
				theme: 'dark',
				status: 'failed',
				reason: 'locator.click: Timeout 10000ms exceeded <a href="/x">'
			},
			{
				screen: 'offline',
				state: 'today',
				device: 'iphone',
				design: 'current',
				theme: 'light',
				status: 'skipped',
				reason: 'offline emulation is Chromium-only'
			}
		]);
		expect(rows(html)).toEqual([
			['coach--empty', 'captured', ...missing(7)],
			['coach--inbox', 'failed', ...missing(7)],
			['offline--today', 'missing', 'skipped', ...missing(6)]
		]);
		// The reason is shown as text, never as markup.
		expect(html).toContain('Timeout 10000ms exceeded &lt;a href=&quot;/x&quot;&gt;');
		expect(html).not.toContain('<a href="/x">');
		expect(html).toContain('offline emulation is Chromium-only');
		expect(html).toContain('1 captured · 1 failed · 1 skipped');
	});

	it('keeps the last record of a shot taken twice', () => {
		const failed: ShotRecord = {
			...captured('today', 'sessions', 'iphone', 'dark'),
			status: 'failed',
			reason: 'first attempt'
		};
		const html = renderIndex([failed, captured('today', 'sessions', 'iphone', 'dark')]);
		expect(rows(html)).toEqual([['today--sessions', 'captured', ...missing(7)]]);
		expect(html).not.toContain('first attempt');
		expect(html).toContain('1 captured · 0 failed');
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
				line({ ...captured('coach', 'inbox', 'iphone', 'dark'), status: 'failed', reason: 'gone' })
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
			'coach--inbox--iphone'
		]);

		const run = spawnSync(process.execPath, ['scripts/gallery-index.ts', dir], {
			cwd: root,
			encoding: 'utf8'
		});
		expect(run.status, run.stderr).toBe(0);
		expect(run.stdout).toContain('3 shots indexed, 1 failed');
		const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
		expect(rows(html)).toEqual([
			['today--sessions', 'captured', ...missing(4), 'captured', ...missing(2)],
			['coach--inbox', 'failed', ...missing(7)]
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
