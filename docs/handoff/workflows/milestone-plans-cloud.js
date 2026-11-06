export const meta = {
	name: 'milestone-plans-cloud',
	description:
		'Plan milestones as small atomic PR slices, one after another (two planners → synthesizer grounded in the code → completeness critic → plan file), each building on the earlier plans',
	phases: [
		{ title: 'Plan', detail: 'two planners, different angles' },
		{ title: 'Synthesize', detail: 'merge, check against real code, assign tracks and dependencies' },
		{ title: 'Critique', detail: 'coverage of every brief step and acceptance criterion' }
	]
};

const S = '<scratch>';
const MAIN = '/home/user/performance-coach';
const BASE = 'origin/main';

const SLICE = {
	type: 'object',
	properties: {
		id: { type: 'string', description: 'kebab-case' },
		branch: { type: 'string', description: 'e.g. m4/03-workout-store' },
		title: { type: 'string', description: 'Conventional Commit subject for the PR' },
		track: { type: 'string' },
		dependsOn: {
			type: 'array',
			items: { type: 'string' },
			description:
				'ids of slices in this plan, or of earlier-milestone slices (M3 ids as in m3-plan.json; M2 onboarding-plan ids such as profile-equipment), that must merge first'
		},
		goal: { type: 'string' },
		newOrChanged: { type: 'array', items: { type: 'string' }, description: 'files/modules and what changes in each' },
		tests: { type: 'array', items: { type: 'string' } },
		acceptance: { type: 'array', items: { type: 'string' } },
		risks: { type: 'string' },
		estNonTestLines: { type: 'number' },
		ui: { type: 'boolean' },
		migration: { type: 'boolean' }
	},
	required: ['id', 'branch', 'title', 'track', 'dependsOn', 'goal', 'newOrChanged', 'tests', 'acceptance', 'estNonTestLines', 'ui', 'migration']
};
const PLAN = {
	type: 'object',
	properties: {
		milestone: { type: 'string' },
		decisions: { type: 'array', items: { type: 'string' }, description: 'key architecture decisions with reasons' },
		slices: { type: 'array', items: SLICE },
		coverage: { type: 'array', items: { type: 'string' }, description: 'each brief step / acceptance criterion → slice ids' },
		openQuestions: { type: 'array', items: { type: 'string' } }
	},
	required: ['milestone', 'decisions', 'slices', 'coverage']
};

async function planOne(M, brief, prior, extra) {
	const BRIEF = `git -C ${MAIN} show origin/handoff:docs/handoff/briefs/${brief}`;
	const OUT = `${S}/plans/${M.toLowerCase()}-plan.json`;
	const PRIOR = prior.map((p) => `${S}/plans/${p}`).join(', ');
	const CONTEXT = `Project: "Performance Coach" (GitHub TheCruzControll/performance-coach), a private single-user AI training PWA: SvelteKit 3 / Svelte 5 runes, TypeScript strict, Postgres + Drizzle, passkeys, Vercel + Neon. You PLAN milestone ${M}; you write no product code.

Read: the brief (\`${BRIEF}\`), docs/product-requirements.md, docs/milestones.md, docs/architecture.md, docs/agent-architecture.md, docs/testing.md, docs/performance.md, docs/design-system.md, and the actual code at ${BASE} (\`git -C ${MAIN} fetch -q origin\`, then \`git -C ${MAIN} show ${BASE}:<path>\`, \`git -C ${MAIN} ls-tree -r --name-only ${BASE}\`, \`git -C ${MAIN} grep <pattern> ${BASE}\`). Never modify any checkout. ${BASE} contains M1, M2's passkey auth and training-profile services and input primitives, and the first M3 slices. Two plans are being built in parallel right now and land before your slices: M2's Profile editing, onboarding and Today screens (\`git -C ${MAIN} show origin/handoff:docs/handoff/briefs/m2-onboarding-plan.json\`) and all of M3, the training data model and programs (${S}/plans/m3-plan.json: its slices' branches m3/NN-* may already be on origin with work in progress). Do not plan anything they plan; build on what they will provide, and name the exact earlier slice ids you depend on. Earlier milestone plans to build on: ${PRIOR}.${extra ? `\n${extra}` : ''}

THE OWNER'S RULES for the plan: every slice is ONE small atomic PR, green on its own (lint, svelte-check, unit, integration on real Postgres, Vercel + Node builds, JS/CSS budgets, Playwright on Chromium + WebKit, Lighthouse), ideally ≤ 600 lines of non-test code. Each has real tests that prove its behaviour. Order slices so each builds on merged work; group them into TRACKS that can be built IN PARALLEL by different engineers with minimal file overlap (shared hot files such as the schema index, the migration journal, the route-access table and docs cause merge conflicts: say how to avoid them, e.g. one migration per slice in a single serial 'schema' track, or separate schema files). Migrations must stay in a strict order (enforced by a unit test), so all slices that add a migration must be in a serial chain, after M3's migrations. Shared docs (docs/testing.md, docs/security.md, docs/performance.md) serialise merges: each code slice adds at most one line there, and the milestone's doc updates land in one docs slice at the end. Performance budgets are tight: initial JS ≤ 60 KB gzip per route (some routes have under 1 KB headroom), lazy-load heavy UI. Separate domain (pure, unit-tested), server/db repositories, services, agent, client, ui and routes layers per docs/architecture.md. Plan the complete milestone (not an MVP): every step and acceptance criterion of the brief must map to slices.`;

	const [a, b] = await parallel([
		() =>
			agent(
				`${CONTEXT}

YOUR ANGLE: bottom-up, foundations first. Start from the data model and domain rules, then repositories and services, then routes/UI, then docs. Optimise for correctness of the schema and for parallel tracks. Return the full plan.`,
				{ label: `plan-a:${M}`, phase: 'Plan', schema: PLAN }
			),
		() =>
			agent(
				`${CONTEXT}

YOUR ANGLE: acceptance-first vertical slices. Start from each acceptance criterion and the user journeys, and cut thin end-to-end slices that each deliver testable value, while keeping migrations serial. Optimise for early proof of the riskiest parts (performance budgets, query plans, determinism). Return the full plan.`,
				{ label: `plan-b:${M}`, phase: 'Plan', schema: PLAN }
			)
	]);

	let plan = await agent(
		`${CONTEXT}

Two independent planners produced these plans. PLAN A: ${JSON.stringify(a)}

PLAN B: ${JSON.stringify(b)}

You are the SYNTHESIZER. Do not trust either: check their claims against the real code at ${BASE} and the earlier plans (file names, existing services and tables, conventions, budgets). Produce ONE final plan that takes the best structure and fixes both plans' mistakes: realistic sizes (≤ 600 non-test lines each; split anything bigger), correct dependencies (earlier-milestone slice ids where needed), parallel tracks with minimal file overlap, migrations in one serial chain, every brief step and acceptance criterion covered (fill the coverage list). Record key decisions with reasons. Keep slice ids stable, unique across all milestones (prefix them if an id could clash with an M2 or M3 id) and kebab-case; branches '${M.toLowerCase()}/NN-<id>' numbered in a valid build order.`,
		{ label: `synth:${M}`, phase: 'Synthesize', schema: PLAN }
	);

	for (let round = 1; round <= 2; round++) {
		const crit = await agent(
			`${CONTEXT}

You are the COMPLETENESS CRITIC for this plan: ${JSON.stringify(plan)}

Check, against the brief and the code: is every brief step and acceptance criterion fully covered by concrete slices with tests that would prove it? Any slice too big (> 600 non-test lines), not independently green, with wrong or missing dependencies (including on earlier-milestone slices), or whose track would conflict heavily with another track? Anything planned that already exists at ${BASE} or is planned by M2 or M3 (or an earlier plan)? Missing designed states (empty/loading/error), accessibility, budgets or docs? Return {ok, problems[]} where each problem says what to change.`,
			{
				label: `critic:${M}#${round}`,
				phase: 'Critique',
				schema: {
					type: 'object',
					properties: { ok: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } } },
					required: ['ok', 'problems']
				}
			}
		);
		if (!crit || crit.ok || !(crit.problems || []).length) break;
		plan = await agent(
			`${CONTEXT}

Revise this plan to fix every problem the critic found. Plan: ${JSON.stringify(plan)}

Critic: ${JSON.stringify(crit)}

Return the full revised plan.`,
			{ label: `revise:${M}#${round}`, phase: 'Synthesize', schema: PLAN }
		);
	}

	await agent(
		`Write this JSON exactly (pretty-printed with 2 spaces) to ${OUT} (create the directory ${S}/plans if needed) using the Write tool, then reply "ok". JSON: ${JSON.stringify(plan)}`,
		{ label: `write:${M}`, phase: 'Critique', effort: 'low' }
	);
	log(`${M}: ${plan.slices.length} slices planned → ${OUT}`);
	return {
		milestone: M,
		file: OUT,
		slices: plan.slices.map((s) => `${s.branch}  [${s.track}] deps=${s.dependsOn.join(',') || '-'}  ~${s.estNonTestLines}  ${s.title}`),
		openQuestions: plan.openQuestions || []
	};
}

const results = [];
let prior = args.priorPlans || ['m3-plan.json'];
for (const m of args.milestones) {
	results.push(await planOne(m.milestone, m.brief, prior, m.extra || ''));
	prior = [...prior, `${m.milestone.toLowerCase()}-plan.json`];
}
return results;
