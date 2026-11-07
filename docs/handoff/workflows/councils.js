export const meta = {
	name: 'councils',
	description:
		'Blind performance and design councils evaluate the running app; prioritized fixes are implemented and re-evaluated in rounds',
	whenToUse: 'Council passes during development (early, scoped) and the M8 refinement milestone',
	phases: [
		{ title: 'Capture', detail: 'screens + measurements of the real running app' },
		{ title: 'Evaluate', detail: '10 independent blind reviewers' },
		{ title: 'Synthesize', detail: 'investigate disagreements, prioritize by impact' },
		{ title: 'Improve', detail: 'implement, test, commit' }
	]
};

// Private stopping criterion. It lives only in this orchestration code: never interpolate it into
// any prompt, file, report or commit.
const BAR = Number(args.bar); // the owner's private stopping criterion: pass it as args.bar; never commit its value

const A = args; // { branch, label, scope, maxRounds }
const REPO = '/home/user/performance-coach';
const SCRATCH =
	'/tmp/claude-0/-home-user-performance-coach/a0807610-c911-59e6-8a46-93bf7eec1bed/scratchpad';
const DIR = `${SCRATCH}/council/${A.label}`;

const BASE = `You are working on "Performance Coach", a private single-user AI performance coaching PWA (iPhone-first, dark-first; SvelteKit + Postgres; deployed on Vercel at coach.nikocruz.com). Repository: ${REPO}, branch ${A.branch}. Product requirements: ${REPO}/docs/product-requirements.md (sections 15 performance and 16 design are the bar). Environment: Linux, 4 CPUs, Node 22, pnpm; local Postgres 16 (start with \`pg_ctlcluster 16 main start\` if down); Playwright 1.63.0 Chromium preinstalled (never run \`playwright install\`; WebKit is not available locally); Lighthouse via \`pnpm lighthouse\` (Chromium at /opt/pw-browsers/chromium-1243/chrome-linux64/chrome). Never contact or modify hosted infrastructure (Vercel, Neon, GitHub). Be honest: report only what you observed or measured.`;

const REVIEW_SCHEMA = {
	type: 'object',
	properties: {
		role: { type: 'string' },
		score: { type: 'number', minimum: 0, maximum: 10 },
		verdict: { type: 'string', description: 'two or three sentences' },
		strengths: { type: 'array', items: { type: 'string' } },
		issues: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					severity: { type: 'string', enum: ['critical', 'major', 'moderate', 'minor'] },
					area: { type: 'string' },
					description: { type: 'string' },
					evidence: { type: 'string' },
					recommendation: { type: 'string' },
					expectedImpact: { type: 'string' }
				},
				required: ['severity', 'area', 'description', 'evidence', 'recommendation']
			}
		},
		measurementsUsed: { type: 'array', items: { type: 'string' } }
	},
	required: ['role', 'score', 'verdict', 'issues', 'strengths']
};

const PLAN_SCHEMA = {
	type: 'object',
	properties: {
		disagreements: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					topic: { type: 'string' },
					positions: { type: 'string' },
					investigation: { type: 'string' },
					resolution: { type: 'string' }
				},
				required: ['topic', 'positions', 'investigation', 'resolution']
			}
		},
		workItems: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					council: { type: 'string', enum: ['performance', 'design', 'both'] },
					impact: { type: 'string', enum: ['high', 'medium', 'low'] },
					effort: { type: 'string', enum: ['S', 'M', 'L'] },
					raisedBy: { type: 'array', items: { type: 'string' } },
					problem: { type: 'string' },
					change: { type: 'string' },
					verification: { type: 'string' }
				},
				required: ['title', 'council', 'impact', 'problem', 'change', 'verification']
			}
		},
		rejected: {
			type: 'array',
			items: {
				type: 'object',
				properties: { item: { type: 'string' }, reason: { type: 'string' } },
				required: ['item', 'reason']
			}
		}
	},
	required: ['disagreements', 'workItems', 'rejected']
};

const PERF = [
	[
		'Frontend Performance Engineer',
		'bundle size and code splitting, hydration and main-thread work, rendering efficiency, fonts/images/assets, caching and fetch patterns, Lighthouse lab metrics (LCP, TBT, CLS, FCP), unnecessary requests and spinners'
	],
	[
		'Backend Performance Engineer',
		'server latency (Server-Timing, TTFB), query plans and indexes (EXPLAIN), N+1 patterns, connection pooling, payload sizes, caching, agent/LLM call efficiency, background work, sync endpoint efficiency'
	],
	[
		'Mobile Performance Specialist',
		'iPhone-class CPU (4x throttling) and network behaviour, INP for real interactions (set logging, timers, navigation), offline/IndexedDB persistence speed, service worker strategy, memory, battery-unfriendly work, perceived performance of the workout flow'
	],
	[
		'Performance & Reliability Engineer',
		'resilience and correctness under failure: offline/online transitions, sync retries and idempotency, error recovery, timeouts, degraded modes (coach down), observability (RUM, errors, logs), performance budgets and regression guards in CI'
	],
	[
		'Independent Technical Reviewer',
		'challenge the evidence itself: re-run key measurements, look for claims in docs/performance.md that the code or numbers do not support, missing measurements, measurement methodology flaws, and risks the specialists would miss'
	]
];
const DESIGN = [
	[
		'Senior Product Designer',
		'end-to-end product experience and flows (onboarding, today, workout, progress, coach, profile), information architecture, clarity of the core jobs, cohesion across the product, states (empty/loading/error/offline)'
	],
	[
		'Visual Design Specialist',
		'typography, spacing and hierarchy, colour and the dark-first palette, iconography, data visualisation quality, consistency with the token system, premium non-generic identity, light theme quality'
	],
	[
		'Mobile UX Specialist',
		'iPhone ergonomics: one-handed use, thumb reach, 44px+ targets, safe areas, keyboard and input types, gestures, readability mid-set, interruption and resume behaviour, PWA feel'
	],
	[
		'Interaction Designer',
		'micro-interactions, feedback timing, motion purpose and quality (and reduced motion), transitions, optimistic UI feedback, timers, sheets, error recovery affordances, accessibility of interactions'
	],
	[
		'Independent Design Critic',
		'challenge the others: find what still looks generic, inconsistent, cluttered or confusing; compare against best-in-class training and health apps; call out polish gaps and unresolved usability problems the specialists may excuse'
	]
];

const capturePrompt = (round) => `${BASE}

=== YOUR TASK: CAPTURE THE EVIDENCE BUNDLE (round ${round}, scope: ${A.scope}) ===
Build an evidence bundle of the REAL running application (production build) for independent performance and design reviewers. Write everything under ${DIR}/round-${round}/ (create it; overwrite if present). Do not change application code or commit.
1. Production build with the Node adapter (pnpm build:node); start it with the e2e environment the same way e2e/global-setup.ts does (fresh e2e database, migrations, test routes enabled) on a free port; seed REALISTIC data for a single owner (several weeks of strength + running + Muay Thai training with history, a current program, reviews and coach threads where those features exist; reuse existing seed/test helpers where possible). Sign in through the supported test auth flow.
2. Screenshots (PNG, iPhone 15 Pro viewport, deviceScaleFactor 3 is fine) of every important screen and state in scope, in DARK and LIGHT themes: sign-in, onboarding steps, today (fresh / with plan / mid-workout resume), train week + session detail, active workout (exercise, set entry, rest timer running, plate calculator, substitution sheet, completed summary), offline and sync states, history, progress dashboards and exercise detail, weekly/cycle review, coach (thread, streaming, proposal card), profile/security, error/empty states. Name files descriptively; write screens/INDEX.md listing each file with what it shows and how to reach it.
3. Measurements (real numbers only, with commands): pnpm budgets output; Lighthouse mobile median of 5 for each main route (pnpm lighthouse); the perf e2e project output (main-thread blocking); set-logging latency (performance marks: tap → visual confirmation, median/p95 over 20 sets at 4x CPU); INP from web-vitals for realistic interactions on the workout screen at 4x CPU; server timings for main endpoints (Server-Timing headers, 20 requests each, p50/p95); EXPLAIN ANALYZE for the main history/analytics queries on the seeded data; IndexedDB restore time after reload mid-workout; RUM summary from the web_vitals table if populated. Write measurements/MEASUREMENTS.md (tables + raw outputs in files).
4. Stop the server. Return a short summary with the bundle path and anything you could not capture (and why).`;

const reviewPrompt = (role, focus, council, round) => `${BASE}

=== YOUR ROLE: ${role} on the independent ${council} council ===
Evaluate the CURRENT state of the real application independently. Your focus: ${focus}.
Evidence bundle (captured from the running production build): ${DIR}/round-${round}/ — read screens/INDEX.md and view the PNGs with the Read tool, read measurements/MEASUREMENTS.md and the raw outputs. You may also read the code and run your own measurements or start the app yourself (use a free port and a separate e2e database name to avoid clashing with other reviewers; stop anything you start). Evidence beats opinion: tie every issue to a screenshot, a measurement, a file:line or a reproduction.
Work blind: do not look for, read or ask about other reviewers' opinions or scores, previous review rounds, or council reports; form your own judgement from the product itself.
Score the current state from 0 to 10 for your area of responsibility, where 10 means exceptional and best-in-class with nothing meaningful left to improve, 8 means very good with clear room to improve, 6 means acceptable but ordinary, and below 5 means significant problems. Be calibrated and demanding: a score must be justified by the evidence you cite. List concrete issues (severity, evidence, recommendation, expected impact), strengths, and the measurements you relied on.`;

const synthPrompt = (round, reviews) => `${BASE}

=== YOUR ROLE: council chair (round ${round}) ===
Ten independent reviewers (5 performance, 5 design) evaluated the running app. Their full reviews are below as JSON.
1. Investigate disagreements: where reviewers contradict each other (e.g. one says a screen is clear, another says confusing; one says a metric is fine, another flags it), check the evidence yourself (screenshots in ${DIR}/round-${round}/, measurements, code, or a quick reproduction) and record the resolution — do not average opinions away.
2. Produce a prioritized list of work items ordered by impact on the owner's experience (performance and design are equally important), merging duplicates, each with the concrete change and how to verify it. Include every critical/major issue that holds up; include moderate/minor ones when cheap or when several reviewers raised them. List rejected items with reasons.
Reviews:
${JSON.stringify(reviews, null, 1)}`;

const improvePrompt = (round, items) => `${BASE}

=== YOUR TASK: IMPLEMENT COUNCIL IMPROVEMENTS (round ${round}) ===
Work on branch ${A.branch} only (never push, never switch branches, never rewrite history). Implement the work items below in priority order. For each: fix the root cause properly (no faked metrics, no weakened tests, no skipped tests), keep the design system consistent (update tokens/components rather than one-off styles), re-run the relevant checks (pnpm check, lint, unit/integration/e2e for affected areas, budgets, perf project, Lighthouse when relevant) and record real before/after numbers for performance items in docs/performance.md. Commit in small Conventional Commits; every commit message ends with exactly:
<commit trailer lines for your environment>
Claude-Session: <session link>
Before finishing run the full gate (pnpm check, pnpm lint, pnpm test:unit, pnpm test:integration, pnpm build, pnpm build:node, pnpm budgets, pnpm test:e2e) and make it green. Return what you changed per item (with evidence) and anything you could not do.
Work items:
${JSON.stringify(items, null, 1)}`;

const MAX = A.maxRounds || 4;
const history = [];
let last = null;
for (let round = 1; round <= MAX; round++) {
	phase('Capture');
	await agent(capturePrompt(round), { label: `capture:r${round}`, phase: 'Capture' });

	phase('Evaluate');
	const panel = [
		...PERF.map(([role, focus]) => ({ role, focus, council: 'performance' })),
		...DESIGN.map(([role, focus]) => ({ role, focus, council: 'design' }))
	];
	const reviews = (
		await parallel(
			panel.map(
				(p) => () =>
					agent(reviewPrompt(p.role, p.focus, p.council, round), {
						label: `review:${p.council}:${p.role}:r${round}`,
						phase: 'Evaluate',
						schema: REVIEW_SCHEMA
					}).then((r) => (r ? { ...r, role: p.role, council: p.council } : null))
			)
		)
	).filter(Boolean);

	const scores = reviews.map((r) => ({ council: r.council, role: r.role, score: r.score }));
	const allIn = reviews.length === panel.length && reviews.every((r) => r.score >= BAR);
	history.push({ round, scores, min: Math.min(...reviews.map((r) => r.score)) });
	log(`Round ${round}: ${scores.map((s) => `${s.role.split(' ')[0]} ${s.score}`).join(' · ')}`);
	last = { round, reviews };
	if (allIn) return { label: A.label, satisfied: true, rounds: history, finalReviews: reviews };
	if (round === MAX) break;

	phase('Synthesize');
	const plan = await agent(synthPrompt(round, reviews), {
		label: `chair:r${round}`,
		phase: 'Synthesize',
		schema: PLAN_SCHEMA
	});
	if (!plan || !plan.workItems.length) {
		log('Chair produced no work items');
		break;
	}

	phase('Improve');
	// Split into two sequential implementation passes so each agent has a focused list.
	const items = plan.workItems;
	const half = Math.ceil(items.length / 2);
	await agent(improvePrompt(round, items.slice(0, half)), {
		label: `improve:r${round}:a`,
		phase: 'Improve'
	});
	if (items.length > half)
		await agent(improvePrompt(round, items.slice(half)), {
			label: `improve:r${round}:b`,
			phase: 'Improve'
		});
}
return { label: A.label, satisfied: false, rounds: history, finalReviews: last && last.reviews };
