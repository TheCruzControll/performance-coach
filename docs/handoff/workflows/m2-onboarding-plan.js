export const meta = {
	name: 'm2-onboarding-plan',
	description:
		'Plan the M2 onboarding/profile/Today work as a stack of atomic, green PRs (two independent planners + synthesis)',
	phases: [
		{ title: 'Plan', detail: 'two independent planners with different decomposition angles' },
		{
			title: 'Synthesize',
			detail: 'merge into one ordered slice plan and check it against the acceptance criteria'
		}
	]
};

const REPO = '/home/user/performance-coach';
const CONTEXT = `Project: "Performance Coach", a private single-user AI training PWA (SvelteKit 3 / Svelte 5 runes, TypeScript strict, Postgres + Drizzle, passkey auth). Repo checkout: ${REPO}. READ-ONLY task: do not modify files, commit, push or switch branches in that checkout; use \`git show <rev>:<path>\` / \`git diff\` / \`git log\` to read other revisions. Do not run the e2e suite.

State:
- origin/m2/11-profile-services (5abf1b4) is the top of an open, green-in-progress PR stack: auth (passkeys, deny-by-default guard, route access table src/lib/server/auth/routes.ts with a unit test that fails on unclassified routes) plus the training-profile domain (src/lib/domain/profile), db (migration 0004, repositories) and services (src/lib/server/services/profile) with integration tests.
- Branch m2/12-onboarding (checked out in ${REPO}) is stacked on an OLDER m2/11 and holds three commits: fede7f4 "perf(budgets): count every chunk a route waits for and budget CSS per route" (complete), c35fd8a "fix(test): wait for hydration before tapping buttons…" (complete), and d8bfded "wip(onboarding): …" (UNFINISHED, ~5.4k lines, type-checks and unit tests pass, never exercised end to end, no e2e, no Profile editing screens, no Today states). Inspect it with \`git show --stat d8bfded\` and read the files.
- The milestone brief is in \`git show origin/handoff:docs/handoff/briefs/m2.json\` — step 2 (ONBOARDING & TRAINING PROFILE) and the "acceptance" list are the requirements for this work. The full product spec is docs/product-requirements.md (§2, §3, §18, §19 matter here). Design system: docs/design-system.md; budgets: docs/performance.md (initial JS ≤ 60 KB gzip per route, CSS per route ≤ 14 KB); testing conventions: docs/testing.md and e2e/*.ts.

THE OWNER'S HARD RULE: every change lands as small, ATOMIC PRs — one concern each, each green on its own (check, lint, unit, integration, both builds, budgets, full e2e incl. WebKit in CI), roughly ≤ 600 lines of non-test code, stacked on each other starting from m2/11-profile-services. Each PR must be independently reviewable and leave the app working. Prefer vertical slices that ship a user-visible, tested increment over layers of unused code, but an unused primitive with its /design entry and tests is acceptable. Production is still disabled (vercel.json guards); the production cutover is a SEPARATE later PR — do not plan it here.`;

const PLAN = {
	type: 'object',
	properties: {
		slices: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'short kebab id, e.g. "form-primitives-a"' },
					branch: { type: 'string', description: 'm2/NN-<id>, numbering continues from m2/12' },
					title: { type: 'string', description: 'Conventional Commit PR title' },
					goal: { type: 'string' },
					fromWip: {
						type: 'array',
						items: { type: 'string' },
						description: 'files taken (possibly partially) from d8bfded or the two complete commits'
					},
					newOrChanged: {
						type: 'array',
						items: { type: 'string' },
						description: 'files to create or modify beyond the WIP'
					},
					tests: {
						type: 'array',
						items: { type: 'string' },
						description: 'unit/integration/e2e tests this slice must add or update, concretely'
					},
					acceptance: {
						type: 'array',
						items: { type: 'string' },
						description: 'checkable done-criteria for this slice'
					},
					estNonTestLines: { type: 'number' },
					risks: { type: 'string' }
				},
				required: [
					'id',
					'branch',
					'title',
					'goal',
					'fromWip',
					'newOrChanged',
					'tests',
					'acceptance',
					'estNonTestLines',
					'risks'
				]
			}
		},
		coverage: {
			type: 'array',
			items: { type: 'string' },
			description: 'each brief acceptance criterion relevant here → which slice satisfies it'
		},
		wipAssessment: {
			type: 'string',
			description: 'what in the WIP looks wrong, unfinished or risky after reading it'
		}
	},
	required: ['slices', 'coverage', 'wipAssessment']
};

phase('Plan');
const angles = [
	{
		key: 'vertical',
		prompt:
			'Decompose as VERTICAL, user-visible slices: after the shared primitives and plumbing, each slice adds one or a few onboarding steps end to end (editor component + route + server action + e2e for that step), then review/complete, then Profile editing, then Today states. Optimise for every PR being demonstrably working and tested.'
	},
	{
		key: 'layered',
		prompt:
			'Decompose by DEPENDENCY ORDER with the smallest possible PRs: primitives, client/server form plumbing (with unit tests), editors, routes, tests — but every PR must still be green and justified on its own (no dead code without tests or a /design entry). Optimise for small diffs and minimal coupling between PRs.'
	}
];
const plans = await parallel(
	angles.map(
		(a) => () =>
			agent(
				`${CONTEXT}\n\nYOUR TASK: read the WIP thoroughly (every file in d8bfded, the two complete commits, and the services/schemas they call) and produce an ordered plan of stacked atomic PRs that finishes M2 onboarding + Profile editing + Today states. ${a.prompt}\nThe first two slices should be the two complete commits (fede7f4, c35fd8a) as their own PRs if they are independent concerns. Account for EVERY file in d8bfded (each lands in some slice, or is explicitly dropped with a reason). Note anything in the WIP that looks wrong or unfinished (wipAssessment). Map every relevant brief acceptance criterion to a slice (coverage).`,
				{ label: `planner:${a.key}`, phase: 'Plan', schema: PLAN }
			)
	)
);

phase('Synthesize');
const valid = plans.filter(Boolean);
const final = await agent(
	`${CONTEXT}\n\nTwo planners independently decomposed the remaining M2 onboarding work into stacked atomic PRs. Their plans (JSON):\n\n${valid.map((p, i) => `PLAN ${i + 1}:\n${JSON.stringify(p)}`).join('\n\n')}\n\nYOUR TASK: verify both against the actual code (read the files they reference; check import dependencies so that every slice compiles on its own — a slice may only use files added in itself or earlier slices; check sizes with wc -l), then produce ONE final plan taking the best of both: atomic (one concern each), each green on its own, ≤ ~600 non-test lines where feasible, user-visible increments tested end to end where possible, every WIP file accounted for, every relevant acceptance criterion covered (brief step 2 + acceptance list: onboarding with event/general/multiple ranked goals, experience per discipline, OPTIONAL 1RMs measured vs estimated with "I don't know my 1RM", running/Muay Thai specifics, equipment, injuries, likes/dislikes, schedule, body & nutrition, review; progress indicator, back/forward, save-as-you-go and resume, skippable optional steps; Profile editing of every section incl. goal edit + priority reorder; Today pre/post onboarding states; axe zero violations dark+light on every new screen; screenshots of every onboarding step; budgets; e2e: complete onboarding leaving EVERY 1RM blank → persists across reload and in Postgres; resume a half-finished onboarding after reload; edit a goal and reorder priorities from Profile). Number branches from m2/12 upward. Fold the planners' WIP concerns into wipAssessment and into each affected slice's acceptance/risks.`,
	{ label: 'synthesizer', phase: 'Synthesize', schema: PLAN }
);
return { final, plans: valid };
