/**
 * scripts/gallery-download.sh: downloads a Screen gallery run's artifact with `gh run download`,
 * here a stand-in `gh` on PATH that records its arguments and unpacks two files, as gh does.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'gallery-download-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const bin = path.join(scratch, 'bin');
const calls = path.join(scratch, 'gh-calls.txt');
mkdirSync(bin);
writeFileSync(
	path.join(bin, 'gh'),
	`#!/usr/bin/env bash
echo "$*" >> "${calls}"
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--dir" ]]; then dir="$2"; fi
  shift
done
touch "$dir/today--sessions--iphone--dark.png" "$dir/index.html"
`
);
chmodSync(path.join(bin, 'gh'), 0o755);

function download(...args: string[]) {
	return spawnSync('bash', ['scripts/gallery-download.sh', ...args], {
		cwd: root,
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		encoding: 'utf8'
	});
}

describe('scripts/gallery-download.sh <run id> <dir>', () => {
	it('downloads and unpacks the screen-gallery artifact of that run into a new directory', () => {
		const dir = path.join(scratch, 'out', 'run-1');
		const run = download('42939723798', dir);
		expect(run.status, run.stderr).toBe(0);
		expect(readFileSync(calls, 'utf8').trim()).toBe(
			`run download 42939723798 --name screen-gallery --dir ${dir}`
		);
		expect(run.stdout).toContain(`1 screens in ${dir}; open ${dir}/index.html`);
	});

	it('refuses a missing argument, a run id that is not a number and a directory in use', () => {
		rmSync(calls, { force: true });
		const used = path.join(scratch, 'used');
		mkdirSync(used);
		writeFileSync(path.join(used, 'keep.txt'), 'mine');

		const missing = download('42939723798');
		expect(missing.status).not.toBe(0);
		expect(missing.stderr).toContain('usage: scripts/gallery-download.sh <run id> <dir>');
		const notId = download('latest', path.join(scratch, 'new'));
		expect(notId.status).toBe(2);
		expect(notId.stderr).toContain("'latest' is not a run id");
		const busy = download('42939723798', used);
		expect(busy.status).toBe(2);
		expect(busy.stderr).toContain('is not empty');
		expect(() => readFileSync(calls, 'utf8'), 'gh never ran').toThrow();
	});
});
