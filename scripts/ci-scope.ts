/**
 * `node scripts/ci-scope.ts`: whether this CI run needs its heavy jobs, `light` or `full`
 * (.github/workflows/ci.yml, job `changes`). Written to stdout as `scope=<scope>` for
 * $GITHUB_OUTPUT, and explained on stderr.
 *
 * A run is `light` when nothing it changes can be tested by the heavy jobs (integration tests,
 * the e2e legs, Lighthouse) to find anything new: every changed path is documentation, the plan or
 * agent tooling (LIGHT_PATHS), or it is a merge to main whose tree its pull request already tested.
 * Every other answer is `full`, including every case the script cannot read: a missing commit, an
 * event it does not know, or a git failure. The script never fails.
 *
 * Node builtins only, so CI runs it before `pnpm install`.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Scope = 'light' | 'full';

export interface Decision {
	scope: Scope;
	reason: string;
}

/**
 * Paths no heavy job reads: docs, the plan, agent tooling, Markdown at the repo root, and
 * `.env.example` (documentation of the environment; only unit guards read it).
 */
export const LIGHT_PATHS: readonly RegExp[] = [
	/^docs\//,
	/^plan\//,
	/^\.claude\//,
	/^\.agents\//,
	/^\.codex\//,
	/^\.pi\//,
	/^[^/]+\.md$/,
	/^\.env\.example$/
];

/** 'light' only when there is at least one path and every path matches LIGHT_PATHS. */
export function scopeOf(paths: readonly string[]): Scope {
	return paths.length > 0 && paths.every((p) => LIGHT_PATHS.some((re) => re.test(p)))
		? 'light'
		: 'full';
}

/** Runs git with these arguments and returns trimmed stdout; throws on a non-zero exit. */
export type Git = (args: readonly string[]) => string;

export interface RunEnv {
	EVENT_NAME?: string;
	BASE_SHA?: string;
	HEAD_SHA?: string;
	BEFORE_SHA?: string;
	SHA?: string;
}

const ZERO_SHA = /^0+$/;

/** The changed paths git lists for `args` (a diff), one per line. */
function changedPaths(git: Git, args: readonly string[]): string[] {
	return git(['diff', '--name-only', '--no-renames', ...args])
		.split('\n')
		.filter((line) => line !== '');
}

/** The scope of a run whose changed paths are `paths`, with the reason for it. */
function byPaths(paths: readonly string[]): Decision {
	if (paths.length === 0) return { scope: 'full', reason: 'no changed files' };
	const scope = scopeOf(paths);
	if (scope === 'light') {
		return {
			scope,
			reason: `only docs, plan or agent tooling changed (${paths.length} files)`
		};
	}
	const first = paths.find((p) => !LIGHT_PATHS.some((re) => re.test(p)));
	return { scope, reason: `changes ${first}` };
}

/** The scope of this run, from its event's environment and git (scripts/ci-scope.ts). */
export function decide(env: RunEnv, git: Git): Decision {
	try {
		if (env.EVENT_NAME === 'pull_request') {
			if (!env.BASE_SHA || !env.HEAD_SHA) {
				return { scope: 'full', reason: 'no pull request commits' };
			}
			return byPaths(changedPaths(git, [`${env.BASE_SHA}...${env.HEAD_SHA}`]));
		}
		if (env.EVENT_NAME === 'push') {
			const sha = env.SHA;
			if (!sha) return { scope: 'full', reason: 'no commit' };
			const parents = git(['rev-list', '--parents', '-n', '1', sha]).split(' ').slice(1);
			if (
				parents.length === 2 &&
				git(['rev-parse', `${sha}^{tree}`]) === git(['rev-parse', `${parents[1]}^{tree}`])
			) {
				return { scope: 'light', reason: 'merge of a tree its pull request already tested' };
			}
			if (!env.BEFORE_SHA || ZERO_SHA.test(env.BEFORE_SHA)) {
				return { scope: 'full', reason: 'no previous commit' };
			}
			return byPaths(changedPaths(git, [env.BEFORE_SHA, sha]));
		}
		return { scope: 'full', reason: `event ${env.EVENT_NAME || 'none'}` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { scope: 'full', reason: `git failed: ${message}` };
	}
}

/** A Git that runs the git on PATH in the working directory, and throws when it fails. */
function gitInThisRepo(): Git {
	return (args) => {
		const result = spawnSync('git', args, { encoding: 'utf8' });
		if (result.error) throw result.error;
		if (result.status !== 0) {
			throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`);
		}
		return result.stdout.trim();
	};
}

function main(): void {
	const decision = decide(process.env, gitInThisRepo());
	process.stdout.write(`scope=${decision.scope}\n`);
	process.stderr.write(`ci scope: ${decision.scope} (${decision.reason})\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
