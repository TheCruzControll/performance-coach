/**
 * Scans the repository for secrets in the formats of scripts/secrets-patterns.ts. The
 * repository is public, so a secret on any branch, in any commit, is already exposed: the fix is
 * to rotate it at its provider, never to rewrite history.
 *
 *   pnpm security:scan               the tracked tree (working copy of every tracked file)
 *   pnpm security:scan --history     every commit reachable from HEAD (CI: main plus the PR)
 *   pnpm security:scan --refs all    every branch on origin; run `git fetch --prune origin`
 *                                    first. A one-off audit for the security register, not CI.
 *
 * A hit that is a test fixture goes into .secrets-allowlist.json by fingerprint (its path and
 * reason are for the reader; only the fingerprint matches). The history and refs scans see every
 * committed line, so there an allowlisted fingerprint they no longer find fails as stale.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { findSecrets, fingerprint, mask } from './secrets-patterns.ts';

export const ALLOWLIST_FILE = '.secrets-allowlist.json';

export interface AllowlistEntry {
	fingerprint: string;
	path: string;
	reason: string;
}

export interface Finding {
	label: string;
	fingerprint: string;
	masked: string;
	path: string;
	line: number;
	commit?: string;
}

export type ScanMode = 'tree' | 'history' | 'refs';

export interface ScanResult {
	mode: ScanMode;
	findings: Finding[];
	allowed: number;
	stale: AllowlistEntry[];
	refs: string[];
	commits: number;
	files: number;
}

const git = (cwd: string, args: string[]) =>
	execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Text a scan skips: binary content (fonts, images) holds no readable secret. */
const isBinary = (buffer: Buffer) => buffer.subarray(0, 8000).includes(0);

/** Findings in a block of lines, each with the file line it came from. */
function scanLines(
	lines: string[],
	numbers: number[],
	where: { path: string; commit?: string }
): Finding[] {
	const text = lines.join('\n');
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	return findSecrets(text).map((hit) => {
		let i = starts.length - 1;
		while (starts[i]! > hit.index) i--;
		return {
			...where,
			label: hit.format.label,
			fingerprint: fingerprint(hit.value),
			masked: mask(hit.value),
			line: numbers[i]!
		};
	});
}

function scanTree(root: string): { findings: Finding[]; files: number } {
	const paths = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
	const findings: Finding[] = [];
	let files = 0;
	for (const file of paths) {
		let buffer: Buffer;
		try {
			buffer = readFileSync(path.join(root, file));
		} catch {
			continue; // deleted in the working copy, or a submodule
		}
		if (isBinary(buffer)) continue;
		files++;
		const lines = buffer.toString('utf8').split('\n');
		findings.push(
			...scanLines(
				lines,
				lines.map((_, i) => i + 1),
				{ path: file }
			)
		);
	}
	return { findings, files };
}

/**
 * Streams `git log -p` over `revs` and scans each commit's added lines per file (a deleted file's
 * lines were added by an earlier commit, so they are scanned there). A merge is diffed against its
 * first parent, since `git log -p` prints no patch for a merge and a line added while merging
 * would otherwise go unscanned.
 */
async function scanLog(root: string, revs: string[]) {
	const child = spawn(
		'git',
		[
			'-c',
			'core.quotePath=false',
			'log',
			...revs,
			'-p',
			'-U0',
			'--diff-merges=first-parent',
			'--no-textconv',
			'--no-ext-diff',
			'--no-color',
			'--format=commit %H'
		],
		{ cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }
	);
	const findings: Finding[] = [];
	let commits = 0;
	let commit = '';
	let file = '';
	let next = 0;
	let header = false;
	let lines: string[] = [];
	let numbers: number[] = [];
	const flush = () => {
		if (lines.length) findings.push(...scanLines(lines, numbers, { path: file, commit }));
		lines = [];
		numbers = [];
	};
	for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
		if (line.startsWith('commit ')) {
			flush();
			commit = line.slice(7, 19);
			commits++;
		} else if (line.startsWith('diff --git ')) {
			flush();
			header = true;
		} else if (header && line.startsWith('+++ ')) {
			file = line.startsWith('+++ b/') ? line.slice(6) : line.slice(4);
		} else if (line.startsWith('@@ ')) {
			header = false;
			next = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
		} else if (!header && line.startsWith('+')) {
			lines.push(line.slice(1));
			numbers.push(next++);
		}
	}
	flush();
	const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
	if (code !== 0) throw new Error(`git log exited with ${code}`);
	return { findings, commits };
}

export function readAllowlist(root: string): AllowlistEntry[] {
	try {
		return (
			JSON.parse(readFileSync(path.join(root, ALLOWLIST_FILE), 'utf8')) as {
				entries: AllowlistEntry[];
			}
		).entries;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
}

export async function runScan(root: string, mode: ScanMode): Promise<ScanResult> {
	let found: Finding[];
	let refs: string[] = [];
	let commits = 0;
	let files = 0;
	if (mode === 'tree') {
		({ findings: found, files } = scanTree(root));
	} else {
		refs =
			mode === 'refs'
				? git(root, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'])
						.split('\n')
						.filter((ref) => ref && ref !== 'refs/remotes/origin/HEAD')
				: ['HEAD'];
		if (!refs.length) throw new Error('no branches under refs/remotes/origin: fetch origin first');
		({ findings: found, commits } = await scanLog(root, refs));
	}
	const allowlist = readAllowlist(root);
	const allowed = new Set(allowlist.map((entry) => entry.fingerprint));
	const findings = found.filter((f) => !allowed.has(f.fingerprint));
	const seen = new Set(found.map((f) => f.fingerprint));
	const stale = mode === 'tree' ? [] : allowlist.filter((entry) => !seen.has(entry.fingerprint));
	return { mode, findings, allowed: found.length - findings.length, stale, refs, commits, files };
}

export const REMEDIATION = [
	'A real credential: rotate it at its provider now (the repository is public and cloned, so',
	'rewriting history does not unpublish it), then remove it from the tree.',
	`A test fixture or placeholder: add its fingerprint, path and reason to ${ALLOWLIST_FILE}.`
].join('\n');

export function report(result: ScanResult): string {
	const scope =
		result.mode === 'tree'
			? `${result.files} tracked files`
			: `${result.commits} commits on ${result.refs.length} ref${result.refs.length === 1 ? '' : 's'}`;
	const out = [
		`Secrets scan (${result.mode}): ${scope}; ${result.findings.length} findings, ${result.allowed} allowlisted, ${result.stale.length} stale allowlist entries`
	];
	for (const f of result.findings) {
		const at = f.commit ? `${f.commit} ${f.path}:${f.line}` : `${f.path}:${f.line}`;
		out.push(`  - ${at}: ${f.label} ${f.masked}, fingerprint ${f.fingerprint}`);
	}
	for (const entry of result.stale) {
		out.push(
			`  - stale allowlist entry ${entry.fingerprint} (${entry.path}): no longer found, remove it`
		);
	}
	if (result.findings.length) out.push('', REMEDIATION);
	return out.join('\n');
}

export function parseMode(argv: string[]): ScanMode {
	if (argv.length === 0) return 'tree';
	if (argv.length === 1 && argv[0] === '--history') return 'history';
	if (argv.length === 2 && argv[0] === '--refs' && argv[1] === 'all') return 'refs';
	throw new Error('Usage: pnpm security:scan [--history | --refs all]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
	const result = await runScan(root, parseMode(process.argv.slice(2)));
	console.log(report(result));
	if (result.findings.length || result.stale.length) process.exitCode = 1;
}
