import { describe, expect, it } from 'vitest';
import { citations, type Get, listPulls, type Pull, unmerged } from './docs-prs.ts';
import { memoryTree } from './lib/docs-tree.ts';

/**
 * Pull requests as GET /repos/TheCruzControll/performance-coach/pulls returned them on
 * 2026-11-06 (only the fields the check reads; #50 and #130 merged, #140 open). The repository
 * has no closed, unmerged PR yet, so #77 is that shape with its number made up.
 */
const RECORDED: Pull[] = [
	{ number: 130, state: 'closed', merged_at: '2026-11-06T20:27:07Z' },
	{ number: 50, state: 'closed', merged_at: '2026-11-06T07:12:47Z' },
	{ number: 140, state: 'open', merged_at: null },
	{ number: 77, state: 'closed', merged_at: null }
];

/** Serves `pulls` in pages of 100, as the API does, and records every URL asked for. */
function fakeApi(pulls: Pull[]): { get: Get; urls: string[] } {
	const urls: string[] = [];
	return {
		urls,
		get: async (url) => {
			urls.push(url);
			const page = Number(new URL(url).searchParams.get('page'));
			return { status: 200, body: pulls.slice((page - 1) * 100, page * 100) };
		}
	};
}

const tree = memoryTree({
	'docs/milestones.md':
		'Done in PR #50 and #130.\n\nThe trend ADR (#77) and the desktop view (#140).\n',
	'docs/adr/0013-x.md':
		'Since #62, one query at a time. Colour `#121214`, and [link](#62-anchor).\n',
	'docs/notes.txt': '#999 is not markdown'
});

describe('docs:prs', () => {
	it('finds every #NNN in the markdown under docs/, with its line, outside code', () => {
		expect(citations(tree)).toEqual([
			{ doc: 'docs/adr/0013-x.md', line: 1, number: 62 },
			{ doc: 'docs/milestones.md', line: 1, number: 50 },
			{ doc: 'docs/milestones.md', line: 1, number: 130 },
			{ doc: 'docs/milestones.md', line: 3, number: 77 },
			{ doc: 'docs/milestones.md', line: 3, number: 140 }
		]);
	});

	it('fails a closed but unmerged PR, an open one and a number that is no PR', async () => {
		const pulls = await listPulls(fakeApi(RECORDED).get);
		expect(unmerged(citations(tree), pulls)).toEqual([
			'docs/adr/0013-x.md:1 #62 is not a pull request of TheCruzControll/performance-coach',
			'docs/milestones.md:3 #77 is closed without being merged',
			'docs/milestones.md:3 #140 is still open'
		]);
	});

	it('passes when every citation is a merged PR', async () => {
		const merged = memoryTree({ 'docs/a.md': 'PR #50, then #130.' });
		expect(unmerged(citations(merged), await listPulls(fakeApi(RECORDED).get))).toEqual([]);
	});

	it('pages by number until a short page, on the repos/<owner>/<name> path', async () => {
		const many = Array.from({ length: 150 }, (_, i) => ({
			number: i + 1,
			state: 'closed' as const,
			merged_at: '2026-11-06T00:00:00Z'
		}));
		const api = fakeApi(many);
		expect((await listPulls(api.get)).size).toBe(150);
		expect(api.urls).toEqual([
			'https://api.github.com/repos/TheCruzControll/performance-coach/pulls?state=all&per_page=100&page=1',
			'https://api.github.com/repos/TheCruzControll/performance-coach/pulls?state=all&per_page=100&page=2'
		]);
	});

	it('stops on an API error instead of reporting every citation as missing', async () => {
		const limited: Get = async () => ({
			status: 403,
			body: { message: 'API rate limit exceeded' }
		});
		await expect(listPulls(limited)).rejects.toThrow(/answered 403: .*rate limit/);
	});
});
