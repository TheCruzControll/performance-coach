/**
 * `pnpm docs:prs`: every `#NNN` cited under docs/ is a merged pull request of this repository.
 *
 * It lists the repository's pull requests through GitHub's REST API (public, so no token is
 * needed; GITHUB_TOKEN or GH_TOKEN raises the rate limit). It needs the network, so it runs on
 * demand and in docs-m9, never in CI. Behind an HTTPS proxy, run it with NODE_USE_ENV_PROXY=1.
 *
 * Pages are fetched by number on repos/<owner>/<name>, never through the API's `Link` URLs,
 * which point at repositories/<id> paths that some proxies refuse.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prReferences } from './lib/docs-scan.ts';
import { type DocsTree, fsTree } from './lib/docs-tree.ts';

export const REPOSITORY = 'TheCruzControll/performance-coach';
const PAGE_SIZE = 100;

/** The fields of a pull request this check reads. */
export interface Pull {
	number: number;
	state: 'open' | 'closed';
	merged_at: string | null;
}

/** GET a URL; the JSON body and the HTTP status. */
export type Get = (url: string) => Promise<{ status: number; body: unknown }>;

export async function listPulls(get: Get, repository = REPOSITORY): Promise<Map<number, Pull>> {
	const pulls = new Map<number, Pull>();
	for (let page = 1; ; page++) {
		const url = `https://api.github.com/repos/${repository}/pulls?state=all&per_page=${PAGE_SIZE}&page=${page}`;
		const { status, body } = await get(url);
		if (status !== 200 || !Array.isArray(body)) {
			throw new Error(`GET ${url} answered ${status}: ${JSON.stringify(body).slice(0, 200)}`);
		}
		for (const pull of body as Pull[]) pulls.set(pull.number, pull);
		if (body.length < PAGE_SIZE) return pulls;
	}
}

export interface Citation {
	doc: string;
	line: number;
	number: number;
}

export function citations(tree: DocsTree): Citation[] {
	return tree
		.files('docs')
		.filter((doc) => doc.endsWith('.md'))
		.sort()
		.flatMap((doc) => prReferences(tree.read(doc) ?? '').map((ref) => ({ doc, ...ref })));
}

/** One line per citation that is not a merged pull request. */
export function unmerged(cited: Citation[], pulls: Map<number, Pull>): string[] {
	return cited.flatMap(({ doc, line, number }) => {
		const pull = pulls.get(number);
		const where = `${doc}:${line} #${number}`;
		if (!pull) return [`${where} is not a pull request of ${REPOSITORY}`];
		if (pull.merged_at) return [];
		return [`${where} is ${pull.state === 'open' ? 'still open' : 'closed without being merged'}`];
	});
}

const githubGet: Get = async (url) => {
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	const response = await fetch(url, {
		headers: {
			accept: 'application/vnd.github+json',
			'x-github-api-version': '2022-11-28',
			...(token ? { authorization: `Bearer ${token}` } : {})
		}
	});
	return { status: response.status, body: await response.json() };
};

async function main(): Promise<void> {
	const cited = citations(fsTree());
	const failures = unmerged(cited, await listPulls(githubGet));
	const distinct = new Set(cited.map((citation) => citation.number)).size;
	if (failures.length > 0) {
		console.error(`${failures.length} of ${cited.length} PR citations are not merged PRs:`);
		for (const failure of failures) console.error(`  ${failure}`);
		process.exitCode = 1;
		return;
	}
	console.log(`docs:prs: ${cited.length} citations of ${distinct} PRs, every one merged.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
