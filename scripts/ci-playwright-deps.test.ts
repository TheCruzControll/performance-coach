/**
 * scripts/ci-playwright-deps.sh, run against stand-ins for Playwright, sudo and apt-get: what it
 * installs, when it goes to the network, and that only a stalled update or download is killed.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, 'ci-playwright-deps.sh');

/** Playwright's packages: Chromium's, WebKit's, and the tools every install adds. */
const FAKE_PLAYWRIGHT = `#!/bin/sh
shift
pkgs="xvfb fonts-liberation"
for browser in "$@"; do
	case "$browser" in
	chromium) pkgs="$pkgs libnss3 libasound2t64" ;;
	webkit) pkgs="$pkgs libwoff1 libnss3 libgstreamer1.0-0" ;;
	esac
done
command -v sudo >/dev/null || exit 1
exec sudo -- sh -c "apt-get update&& apt-get install -y --no-install-recommends $pkgs"
`;

const FAKE_SUDO = `#!/bin/sh
exec "$@"
`;

/**
 * apt-get: logs each call (and whether a timeout runs it) to $FAKE/log. $FAKE/missing lists the
 * packages not yet downloaded; $FAKE/stall-update and $FAKE/stall-download hold how many attempts
 * hang; $FAKE/unresolvable makes the cached lists fail to resolve.
 */
const FAKE_APT = `#!/bin/sh
lists=
for arg in "$@"; do
	case "$arg" in Dir::State::Lists=*) lists="\${arg#Dir::State::Lists=}" ;; esac
done
parent=$(ps -o comm= -p $PPID | sed 's#.*/##')
echo "$parent: $*" >> "$FAKE/log"
stall() {
	n=$(cat "$FAKE/stall-$1" 2>/dev/null || echo 0)
	if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$FAKE/stall-$1"; exec sleep 30; fi
}
case " $* " in
*" update "*)
	stall update
	echo "Packages" > "$lists/archive.ubuntu.com_ubuntu_dists_noble_main_binary-amd64_Packages"
	;;
*" --print-uris "*)
	[ -f "$FAKE/unresolvable" ] && exit 100
	for p in $(cat "$FAKE/missing" 2>/dev/null); do echo "'http://archive/$p.deb' $p.deb 1 SHA256:0"; done
	;;
*" --download-only "*)
	stall download
	: > "$FAKE/missing"
	;;
*" --no-download "*)
	[ -s "$FAKE/missing" ] && { echo "E: missing" >&2; exit 100; }
	;;
esac
exit 0
`;

let dir: string;
let fake: string;
let cache: string;

function write(file: string, text: string) {
	writeFileSync(join(fake, file), text);
	chmodSync(join(fake, file), 0o755);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'ci-playwright-deps-'));
	fake = join(dir, 'fake');
	cache = join(dir, 'cache');
	spawnSync('mkdir', ['-p', fake, join(fake, 'bin')]);
	write('playwright', FAKE_PLAYWRIGHT);
	write('bin/sudo', FAKE_SUDO);
	write('bin/apt-get', FAKE_APT);
	writeFileSync(
		join(fake, 'ubuntu.sources'),
		[
			'Types: deb deb-src',
			'URIs: mirror+file:/etc/apt/apt-mirrors.txt',
			'Suites: noble noble-updates noble-backports',
			'Components: main universe restricted multiverse',
			''
		].join('\n')
	);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}) {
	const started = Date.now();
	const result = spawnSync('bash', [SCRIPT, ...args], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${join(fake, 'bin')}:${process.env.PATH}`,
			FAKE: fake,
			PLAYWRIGHT: join(fake, 'playwright'),
			APT_UBUNTU_SOURCES: join(fake, 'ubuntu.sources'),
			...env
		}
	});
	return { ...result, seconds: (Date.now() - started) / 1000 };
}

/** Each apt-get call: who ran it (`timeout` or the script) and its subcommand. */
function calls() {
	if (!existsSync(join(fake, 'log'))) return [];
	return readFileSync(join(fake, 'log'), 'utf8')
		.trim()
		.split('\n')
		.map((line) => {
			const [parent, args] = line.split(/: (.*)/s) as [string, string];
			const step = args.includes('--print-uris')
				? 'check'
				: args.includes('--download-only')
					? 'download'
					: args.includes('--no-download')
						? 'dpkg'
						: args.split(' ')[0]!;
			return { parent, step, args };
		});
}

const steps = () => calls().map((c) => `${c.step}${c.parent === 'timeout' ? ' (bounded)' : ''}`);

/** A cache a previous run saved: lists, and every package but `missing`. */
function seedCache(missing: string[] = []) {
	spawnSync('mkdir', ['-p', join(cache, 'lists'), join(cache, 'archives')]);
	writeFileSync(join(cache, 'lists', 'archive.ubuntu.com_noble_Packages'), 'Packages');
	writeFileSync(join(fake, 'missing'), missing.join('\n'));
}

describe('ci-playwright-deps.sh packages', () => {
	it('lists what Playwright would install for the browsers named, sorted, once each', () => {
		const result = run(['packages', 'chromium', 'webkit']);
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		expect(result.stdout.trim().split('\n')).toEqual([
			'fonts-liberation',
			'libasound2t64',
			'libgstreamer1.0-0',
			'libnss3',
			'libwoff1',
			'xvfb'
		]);
		expect(calls(), 'nothing is installed').toEqual([]);
	});

	it('fails, rather than install nothing, when Playwright prints no package list', () => {
		write('playwright', '#!/bin/sh\necho "BEWARE: unsupported"\n');
		const result = run(['packages', 'chromium']);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('no package list');
	});
});

describe('ci-playwright-deps.sh key', () => {
	it('changes with the package set and carries the runner image version', () => {
		const keyOf = (...browsers: string[]) =>
			run(['key', ...browsers], { ImageVersion: '20261101.360.1' }).stdout;
		const both = keyOf('chromium', 'webkit');
		expect(both).toMatch(/^packages=[0-9a-f]{16}\nimage=20261101\.360\.1\n$/);
		expect(keyOf('webkit', 'chromium'), 'same set, other order').toBe(both);
		expect(keyOf('chromium'), 'Chromium alone').not.toBe(both);
	});
});

describe('ci-playwright-deps.sh install', () => {
	it('installs from a complete cache with no apt-get update and no download', () => {
		seedCache();
		const result = run(['install', cache, 'chromium', 'webkit']);
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(steps()).toEqual(['check', 'dpkg']);
		const dpkg = calls().find((c) => c.step === 'dpkg')!;
		for (const pkg of ['libwoff1', 'libnss3', 'xvfb', 'fonts-liberation']) {
			expect(dpkg.args.split(' ')).toContain(pkg);
		}
		expect(dpkg.args).toContain(`Dir::State::Lists=${cache}/lists`);
		expect(dpkg.args).toContain(`Dir::Cache::Archives=${cache}/archives`);
		expect(result.stdout).toContain('Installed from the cache');
	});

	it('updates and downloads only what the cache lacks, then installs with nothing to fetch', () => {
		seedCache(['libwoff1']);
		const result = run(['install', cache, 'chromium', 'webkit']);
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(steps()).toEqual([
			'check',
			'update (bounded)',
			'download (bounded)',
			'autoclean',
			'dpkg'
		]);
	});

	it('goes to the network on a first run, with nothing cached', () => {
		const result = run(['install', cache, 'chromium']);
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(steps()).toEqual(['update (bounded)', 'download (bounded)', 'autoclean', 'dpkg']);
	});

	it('goes to the network when the cached lists no longer resolve (a newer runner image)', () => {
		seedCache();
		writeFileSync(join(fake, 'unresolvable'), '');
		const result = run(['install', cache, 'chromium']);
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(steps()).toEqual([
			'check',
			'update (bounded)',
			'download (bounded)',
			'autoclean',
			'dpkg'
		]);
	});

	it('reads only Ubuntu’s binary indexes, without backports or translations', () => {
		const result = run(['install', cache, 'chromium']);
		expect(result.status, result.stdout + result.stderr).toBe(0);
		const update = calls().find((c) => c.step === 'update')!;
		expect(update.args).toContain('--error-on=any');
		expect(update.args).toContain('Acquire::Languages=none');
		expect(update.args).toContain('Dir::Etc::SourceList=/dev/null');
		expect(update.args).toContain(`Dir::Etc::SourceParts=${cache}/sources`);
		const sources = readFileSync(join(cache, 'sources', 'ubuntu.sources'), 'utf8');
		expect(sources).toContain('Types: deb\n');
		expect(sources).toContain('Suites: noble noble-updates\n');
		expect(sources).toContain('URIs: mirror+file:/etc/apt/apt-mirrors.txt\n');
	});

	it('kills a stalled update and a stalled download and retries them, never dpkg', () => {
		writeFileSync(join(fake, 'stall-update'), '1');
		writeFileSync(join(fake, 'stall-download'), '2');
		const result = run(['install', cache, 'chromium', 'webkit'], {
			APT_UPDATE_SECONDS: '1',
			APT_DOWNLOAD_SECONDS: '1'
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(steps()).toEqual([
			'update (bounded)',
			'update (bounded)',
			'download (bounded)',
			'download (bounded)',
			'download (bounded)',
			'autoclean',
			'dpkg'
		]);
		expect(result.stdout).toContain('apt-get update: attempt 1 of 3 failed or stalled');
		expect(result.stdout).toContain('package download: attempt 2 of 3 failed or stalled');
		expect(result.seconds, 'each stall cut at its bound, not its 30 s').toBeLessThan(20);
	}, 30_000);

	it('gives up after three stalled updates without running dpkg', () => {
		writeFileSync(join(fake, 'stall-update'), '3');
		const result = run(['install', cache, 'chromium'], { APT_UPDATE_SECONDS: '1' });
		expect(result.status).not.toBe(0);
		expect(steps()).toEqual(['update (bounded)', 'update (bounded)', 'update (bounded)']);
		expect(result.stdout).toContain('::error::apt-get update failed 3 times');
	}, 30_000);

	it('leaves the cache without apt’s locks or partial downloads, ready to save', () => {
		const result = run(['install', cache, 'chromium']);
		expect(result.status, result.stdout + result.stderr).toBe(0);
		const left = spawnSync('find', [cache, '-name', 'partial', '-o', '-name', 'lock'], {
			encoding: 'utf8'
		}).stdout;
		expect(left).toBe('');
	});
});
