/**
 * scripts/ci-scope.ts: which CI run is light (docs, plan and agent tooling only, or a merge of a
 * tree its pull request tested) and which is full. Git is faked: each answer is keyed by the
 * arguments joined with spaces, and an argument list the test did not expect throws.
 */
import { describe, expect, it } from 'vitest';
import { type Git, decide, scopeOf } from './ci-scope.ts';

/** A fake git: the output for each joined argument list; any other list throws. */
function fakeGit(answers: Record<string, string>) {
	const calls: string[] = [];
	const git: Git = (args) => {
		const key = args.join(' ');
		calls.push(key);
		if (!Object.hasOwn(answers, key)) throw new Error(`unexpected git ${key}`);
		return answers[key]!;
	};
	return { git, calls };
}

const BASE = 'base1';
const HEAD = 'head1';
const DIFF_PR = `diff --name-only --no-renames ${BASE}...${HEAD}`;

describe('scopeOf', () => {
	it('is full for no paths at all', () => {
		expect(scopeOf([])).toBe('full');
	});

	it('is light for docs, the plan, agent tooling and root Markdown', () => {
		expect(
			scopeOf([
				'docs/a.md',
				'plan/queue.md',
				'.claude/skills/x/SKILL.md',
				'CLAUDE.md',
				'.env.example',
				'.pi/x',
				'.agents/y',
				'.codex/z'
			])
		).toBe('light');
	});

	it('is full as soon as one path is not light', () => {
		expect(scopeOf(['docs/a.md', 'src/x.ts'])).toBe('full');
	});

	it('is full for Markdown nested below the root, which the build can read', () => {
		expect(scopeOf(['src/README.md'])).toBe('full');
		for (const path of ['src/lib/docs/x.ts', 'e2e/plan/x.ts', 'src/.env.example', '.env']) {
			expect(scopeOf([path]), path).toBe('full');
		}
	});

	it('is full for the workflows and the package manifest', () => {
		expect(scopeOf(['.github/workflows/ci.yml'])).toBe('full');
		expect(scopeOf(['package.json'])).toBe('full');
	});
});

describe('decide, pull_request', () => {
	it('is light when the diff against the base touches only light paths', () => {
		const { git, calls } = fakeGit({
			[DIFF_PR]: 'docs/testing.md\nplan/queue.md\n.claude/skills/x/SKILL.md'
		});
		const decision = decide({ EVENT_NAME: 'pull_request', BASE_SHA: BASE, HEAD_SHA: HEAD }, git);
		expect(decision).toEqual({
			scope: 'light',
			reason: 'only docs, plan or agent tooling changed (3 files)'
		});
		expect(calls).toEqual([DIFF_PR]);
	});

	it('is full, naming the first path that is not light, when the diff is mixed', () => {
		const { git } = fakeGit({
			[DIFF_PR]: 'docs/testing.md\nsrc/lib/server/x.ts\nscripts/y.ts'
		});
		const decision = decide({ EVENT_NAME: 'pull_request', BASE_SHA: BASE, HEAD_SHA: HEAD }, git);
		expect(decision).toEqual({ scope: 'full', reason: 'changes src/lib/server/x.ts' });
	});

	it('is full when the diff lists no files', () => {
		const { git } = fakeGit({ [DIFF_PR]: '' });
		expect(decide({ EVENT_NAME: 'pull_request', BASE_SHA: BASE, HEAD_SHA: HEAD }, git)).toEqual({
			scope: 'full',
			reason: 'no changed files'
		});
	});

	it('is full without git when either commit is missing', () => {
		const { git, calls } = fakeGit({});
		expect(decide({ EVENT_NAME: 'pull_request', BASE_SHA: BASE }, git).scope).toBe('full');
		expect(decide({ EVENT_NAME: 'pull_request', HEAD_SHA: HEAD }, git).scope).toBe('full');
		expect(calls).toEqual([]);
	});

	it('diffs the merge base with --no-renames, as one BASE...HEAD argument', () => {
		const { git, calls } = fakeGit({ [DIFF_PR]: 'docs/a.md' });
		decide({ EVENT_NAME: 'pull_request', BASE_SHA: BASE, HEAD_SHA: HEAD }, git);
		expect(calls).toEqual([DIFF_PR]);
		expect(calls[0]).toContain('--no-renames');
		expect(calls[0]).toContain(`${BASE}...${HEAD}`);
	});
});

describe('decide, push', () => {
	const MERGE = 'merge1';
	const BEFORE = 'before1';
	const parents = `${MERGE} ${BEFORE} ${HEAD}`;

	it('is light for a merge whose tree equals its second parent’s, without a diff', () => {
		const { git, calls } = fakeGit({
			[`rev-list --parents -n 1 ${MERGE}`]: parents,
			[`rev-parse ${MERGE}^{tree}`]: 'tree1',
			[`rev-parse ${HEAD}^{tree}`]: 'tree1'
		});
		expect(decide({ EVENT_NAME: 'push', SHA: MERGE, BEFORE_SHA: BEFORE }, git)).toEqual({
			scope: 'light',
			reason: 'merge of a tree its pull request already tested'
		});
		expect(calls.some((call) => call.startsWith('diff'))).toBe(false);
	});

	it('diffs when the merge’s first parent is not the previous tip, even with equal trees', () => {
		const diff = `diff --name-only --no-renames older1 ${MERGE}`;
		const { git } = fakeGit({
			[`rev-list --parents -n 1 ${MERGE}`]: parents,
			[`rev-parse ${MERGE}^{tree}`]: 'tree1',
			[`rev-parse ${HEAD}^{tree}`]: 'tree1',
			[diff]: 'src/app.ts'
		});
		expect(decide({ EVENT_NAME: 'push', SHA: MERGE, BEFORE_SHA: 'older1' }, git)).toEqual({
			scope: 'full',
			reason: 'changes src/app.ts'
		});
	});

	it('diffs before and after when the merge tree differs from its second parent’s', () => {
		const diff = `diff --name-only --no-renames ${BEFORE} ${MERGE}`;
		const { git, calls } = fakeGit({
			[`rev-list --parents -n 1 ${MERGE}`]: parents,
			[`rev-parse ${MERGE}^{tree}`]: 'tree1',
			[`rev-parse ${HEAD}^{tree}`]: 'tree2',
			[diff]: 'src/app.ts'
		});
		expect(decide({ EVENT_NAME: 'push', SHA: MERGE, BEFORE_SHA: BEFORE }, git)).toEqual({
			scope: 'full',
			reason: 'changes src/app.ts'
		});
		expect(calls).toContain(diff);
	});

	it('diffs before and after for a commit with one parent', () => {
		const diff = `diff --name-only --no-renames ${BEFORE} ${MERGE}`;
		const { git, calls } = fakeGit({
			[`rev-list --parents -n 1 ${MERGE}`]: `${MERGE} ${BEFORE}`,
			[diff]: 'docs/testing.md\nplan/queue.md'
		});
		expect(decide({ EVENT_NAME: 'push', SHA: MERGE, BEFORE_SHA: BEFORE }, git)).toEqual({
			scope: 'light',
			reason: 'only docs, plan or agent tooling changed (2 files)'
		});
		expect(calls).toEqual([`rev-list --parents -n 1 ${MERGE}`, diff]);
	});

	it('is full when the previous commit is all zeros, as on a new branch', () => {
		const zeros = '0000000000000000000000000000000000000000';
		const { git, calls } = fakeGit({
			[`rev-list --parents -n 1 ${MERGE}`]: `${MERGE} ${BEFORE}`
		});
		expect(decide({ EVENT_NAME: 'push', SHA: MERGE, BEFORE_SHA: zeros }, git)).toEqual({
			scope: 'full',
			reason: 'no previous commit'
		});
		expect(calls.some((call) => call.startsWith('diff'))).toBe(false);
	});
});

describe('decide, other events and failures', () => {
	it('is full for a manual run', () => {
		const { git, calls } = fakeGit({});
		expect(decide({ EVENT_NAME: 'workflow_dispatch', SHA: 'x' }, git)).toEqual({
			scope: 'full',
			reason: 'event workflow_dispatch'
		});
		expect(decide({ EVENT_NAME: 'schedule', SHA: 'x' }, git)).toEqual({
			scope: 'full',
			reason: 'event schedule'
		});
		expect(calls).toEqual([]);
	});

	it('is full, and does not throw, when git fails', () => {
		const git: Git = () => {
			throw new Error('fatal: bad object');
		};
		const decision = decide({ EVENT_NAME: 'push', SHA: 'x', BEFORE_SHA: 'y' }, git);
		expect(decision.scope).toBe('full');
		expect(decision.reason).toMatch(/^git failed: /);
	});
});
