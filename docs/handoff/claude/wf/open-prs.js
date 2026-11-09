export const meta = {
	name: 'open-prs',
	description: 'Get the open slice PRs ready: fix red E2E runs, review unreviewed PRs, each fix reviewed in a fresh-reviewer loop, then push',
	phases: [
		{ title: 'Fix', detail: 'a fixer per red PR reads the failing CI logs and pushes the smallest fix' },
		{ title: 'Review', detail: 'fresh Opus reviewer each round on the fix (or the whole PR), fixer answers findings' },
		{ title: 'Body', detail: 'record the review line in the PR body' }
	]
};

const S = '/tmp/pc-scratch';
const BIN = `${S}/bin`;
const MAIN = '/Users/nikocruz/dev/performance-coach';
const WT = '/tmp/pc-wt';
const RP = 'TheCruzControll/performance-coach';
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const ITEMS = args.items; // [{pr, branch, slug, port, mode: 'ci'|'review', effort, failing}]

// At most args.limit agents at once.
let active = 0;
const q = [];
const limit = (fn) =>
	new Promise((res, rej) => {
		q.push({ fn, res, rej });
		pump();
	});
function pump() {
	while (active < (args.limit || 3) && q.length) {
		const { fn, res, rej } = q.shift();
		active++;
		fn().then(res, rej).finally(() => {
			active--;
			pump();
		});
	}
}

const ENV = (it) => `Work only in the worktree ${WT}/${it.slug}. Set it up first: if it does not exist, \`git -C ${MAIN} fetch -q origin && git -C ${MAIN} worktree add ${WT}/${it.slug} -B ${it.branch} origin/${it.branch}\`; if it exists, make sure it is on ${it.branch} at origin/${it.branch} or ahead. Then inside it run \`bash ${BIN}/agent-env ${it.slug} ${it.port}\` once, and prefix every node/pnpm command with \`source ${S}/env/${it.slug}.sh && \`. Postgres 18 runs on localhost:5432 (role coach/coach). Heavy commands (pnpm check, pnpm lint, full pnpm test:unit, vite builds, Playwright) go through \`slot\` (3 machine-wide; if slot exits 75, retry later through slot). Bash timeouts 600000 for heavy calls. If a command talking to Postgres or the network fails with a sandbox/permission error, rerun it with the sandbox disabled.
Never run Lighthouse, pnpm build, pnpm budgets locally. You MAY run the one or two failing Playwright specs locally to reproduce (Chromium only: \`slot pnpm exec playwright test <spec> --project=<project>\`; read playwright.config.ts for project names; it builds and serves the app itself, which is allowed for this). Browsers cannot launch inside this session's sandbox (Mach-port denial); the owner runs a Playwright browser server outside it: set PW_TEST_CONNECT_WS_ENDPOINT=ws://127.0.0.1:3333/ for \`playwright test\`, or \`chromium.connect('ws://127.0.0.1:3333/')\` in a script (pass headers {'x-playwright-launch-options': JSON.stringify({headless:false})} for headed). Kill any server you start. Local macOS WebKit differs from CI's Linux WebKit, so CI is the WebKit gate.
Known traps: an e2e test that holds/fails/fulfils requests with page.route must run with \`test.use({ serviceWorkers: 'block' })\` (WebKit's page.route misses service-worker-controlled requests); wait on \`document.fonts.status === 'loaded'\`, never \`document.fonts.ready\`, while a request is held; a test comparing text across a reload must wait for lazily loaded components first. One query at a time per db Executor (never Promise.all over one db handle).
Shared docs (docs/testing.md, security.md, performance.md, milestones.md) are not edited by code fixes.
GitHub: gh is authenticated. The only writes allowed: pushing ${it.branch} (fast-forward, new commits only: no amend, rebase or force-push; other branches may stack on it) and editing PR #${it.pr}'s body when told to. Never merge, comment, rerun CI or touch other PRs.
Commits: Conventional Commits, subject, blank line, short plain-prose body; end every message with exactly:\n${TRAILER}\nMention no AI model anywhere else.`;

const LIGHT_GATES = (it) => `Local gates: pnpm lint (via slot); slot pnpm check; slot pnpm test:unit; plus \`pnpm db:reset:test && pnpm test:integration\` if the diff touches src/lib/server/db or drizzle. Report real output excerpts.`;

const FIX_OUT = {
	type: 'object',
	properties: {
		cause: { type: 'string' },
		fixed: { type: 'boolean' },
		notOurs: { type: 'string', description: 'only if the failure is not caused by this PR (flake, infra, main): evidence' },
		baseBeforeFix: { type: 'string', description: 'git rev-parse HEAD before your first commit' },
		head: { type: 'string' },
		pushed: { type: 'boolean' },
		checks: { type: 'string' }
	},
	required: ['cause', 'fixed', 'head', 'pushed', 'checks']
};
const REVIEW_OUT = {
	type: 'object',
	properties: {
		verdict: { type: 'string', enum: ['APPROVE', 'CHANGES'] },
		findings: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					severity: { type: 'string', enum: ['blocker', 'should', 'nit'] },
					where: { type: 'string' },
					claim: { type: 'string' },
					fix: { type: 'string' },
					status: { type: 'string', enum: ['new', 'still open', 'resolved'] },
					reason: { type: 'string' }
				},
				required: ['id', 'severity', 'claim', 'status']
			}
		},
		reviewedHead: { type: 'string' },
		text: { type: 'string' }
	},
	required: ['verdict', 'findings', 'reviewedHead', 'text']
};
const ANSWER_OUT = {
	type: 'object',
	properties: {
		ledger: {
			type: 'array',
			items: {
				type: 'object',
				properties: { id: { type: 'string' }, severity: { type: 'string' }, outcome: { type: 'string', enum: ['fixed', 'disagree', 'declined'] }, evidence: { type: 'string' } },
				required: ['id', 'severity', 'outcome', 'evidence']
			}
		},
		head: { type: 'string' },
		pushed: { type: 'boolean' },
		checks: { type: 'string' }
	},
	required: ['ledger', 'head', 'pushed', 'checks']
};

const ledgerText = (l) => Object.values(l).map((x) => `${x.outcome}: ${x.id} [${x.severity}] ${x.evidence}`).join('\n') || '(empty)';

function reviewPrompt(it, base, head, round, ledger, prevHead) {
	const r1 = `Review only. Do not edit, commit, push, comment on PRs, start subagents, or use the sol-review or council skills.
Repo: ${MAIN} (read files with git show ${head}:<path>; run \`git -C ${MAIN} fetch -q origin\` first) Base: ${base} Head: ${head}
Intent: ${it.mode === 'ci' ? `PR #${it.pr} (${it.branch}) was already reviewed and approved; its CI E2E job then failed. This diff is ONLY the fix for that failure (cause per the fixer: ${it.cause || 'see commits'}). It must fix the real cause without skipping, weakening or quarantining a test, and without raising a timeout or budget.` : `PR #${it.pr} (${it.branch}): \`gh pr view ${it.pr} -R ${RP} --json title,body\` states its intent. The plan slice behind it is in ${S}/plans/*-plan.json (find the slice whose branch is ${it.branch}; read its goal, tests and acceptance). It must do exactly that, with tests that prove it.`}
Out of scope: anything outside that intent; prose style.
See: git -C ${MAIN} diff ${base} ${head}
Read surrounding code. Find bugs, broken callers, mismatch with intent. Skip style unless it hides a bug. Hold to the smallest change. Flag code, tests, or guards the intent does not need. Other paths, rare cases, small perf, extra compat: nits.
blocker = intended case wrong. should = real bug callers will hit, in intent. nit = rest. VERDICT is APPROVE when no blocker or should remains open.
Reply in the structured output: verdict, findings (stable ids S1, S2, ...: severity, where file:line, claim, fix, status), reviewedHead (= ${head}), text (VERDICT line + one line per finding).`;
	if (round === 1) return r1;
	return `${r1}\n\nRound ${round}. Ledger (the branch owner's answers):\n${ledgerText(ledger)}\nThe change since your last round: git -C ${MAIN} diff ${prevHead} ${head}. Open ids and changed code only; mark each old id resolved or still open (reason). New findings continue the numbering.`;
}

async function reviewLoop(it, base, head0, effort) {
	const max = effort === 'xhigh' ? 5 : 3;
	let head = head0, prevHead = null;
	const ledger = {}, disputed = {};
	for (let r = 1; r <= max; r++) {
		const rev = await limit(() => agent(reviewPrompt(it, base, head, r, ledger, prevHead), { label: `review-r${r}:#${it.pr}`, phase: 'Review', model: 'opus', effort, schema: REVIEW_OUT }));
		if (!rev) return { approved: false, rounds: r, why: 'no reviewer reply', head };
		const open = rev.findings.filter((f) => f.status !== 'resolved' && f.severity !== 'nit');
		if (rev.verdict === 'APPROVE' && !open.length) return { approved: true, rounds: r, head, ledger };
		const stuck = open.filter((f) => (disputed[f.id] || 0) >= 2);
		if (stuck.length || r === max) return { approved: false, rounds: r, head, ledger, why: (stuck.length ? 'stuck: ' : 'budget ended: ') + open.map((f) => `${f.id} [${f.severity}] ${f.claim}`).join(' | ') };
		const ans = await limit(() =>
			agent(
				`${ENV(it)}\nYou own branch ${it.branch} (PR #${it.pr}). A reviewer (round ${r}) reviewed ${base}..${rev.reviewedHead} and replied:\n${rev.text}\nFindings: ${JSON.stringify(rev.findings)}\nLedger so far:\n${ledgerText(ledger)}\nFor each unresolved finding, judge it yourself (another path, rare case or small cost is a nit). Agree: smallest fix, one focused test that fails without it if the intent needs it, committed as a NEW commit. Disagree: say why with evidence. Nit/out of scope: decline in one line. Do not agree just to end the loop.\n${LIGHT_GATES(it)}\nThen \`git push origin ${it.branch}\` (retry network errors up to 4 times). Report ledger, head, pushed, checks.`,
				{ label: `answer-r${r}:#${it.pr}`, phase: 'Review', effort: effort === 'xhigh' ? 'high' : 'medium', schema: ANSWER_OUT }
			)
		);
		if (!ans) return { approved: false, rounds: r, head, ledger, why: 'answering agent failed' };
		for (const l of ans.ledger) {
			ledger[l.id] = l;
			if (l.outcome === 'disagree') disputed[l.id] = (disputed[l.id] || 0) + 1;
		}
		prevHead = rev.reviewedHead;
		head = ans.head || head;
	}
	return { approved: false, rounds: max, head, ledger, why: 'loop ended' };
}

async function bodyLine(it, line) {
	return limit(() =>
		agent(
			`Edit only the description of PR #${it.pr} of ${RP}. \`mkdir -p ${S}/pr-bodies && gh pr view ${it.pr} -R ${RP} --json body -q .body > ${S}/pr-bodies/pr-${it.pr}.md\`. ${it.mode === 'ci' ? 'Keep every existing line. Insert the line below on its own line' : 'If it has a line starting \\`Reviewed with sol-review\\` or \\`Sol review pending\\`, replace that line with exactly the line below; otherwise insert it'} on its own line just before the line starting \`Created with\` (or at the end). Then \`gh pr edit ${it.pr} -R ${RP} --body-file ${S}/pr-bodies/pr-${it.pr}.md\`. Change nothing else. Line:\n${line}\nReply with the final last 4 lines of the body.`,
			{ label: `body:#${it.pr}`, phase: 'Body', model: 'haiku', effort: 'low' }
		)
	);
}

async function doItem(it) {
	let base, head;
	if (it.mode === 'conflict') {
		const MERGE_OUT = { type: 'object', properties: { mergeCommit: { type: 'string' }, resolution: { type: 'string' }, checks: { type: 'string' } }, required: ['mergeCommit', 'resolution', 'checks'] };
		const VERIFY_OUT = { type: 'object', properties: { verdict: { type: 'string', enum: ['APPROVE', 'CHANGES'] }, problems: { type: 'string' } }, required: ['verdict', 'problems'] };
		let feedback = '';
		for (let r = 1; r <= 3; r++) {
			const m = await limit(() =>
				agent(
					`${ENV(it)}\nPR #${it.pr} (${it.branch}) conflicts with main${it.why ? ` (${it.why})` : ''}. ${r === 1 ? `\`git fetch -q origin && git merge origin/main\` (message "Merge main into ${it.branch}") and resolve every conflict keeping BOTH sides' intent: registries and lists keep every entry from both sides; for code, understand what main's change (read the merged PR that brought it: \`git log origin/main --merges -5\`) and this PR each wanted, and combine them.` : `A verifier rejected your resolution (merge commit is HEAD, not pushed):\n${feedback}\nFix it with a new commit on top (do not rewrite the merge).`} Then run ${LIGHT_GATES(it)} DO NOT PUSH. Report mergeCommit (the merge commit sha), resolution (file by file, what each side wanted and what you kept), checks.`,
					{ label: `merge-r${r}:#${it.pr}`, phase: 'Fix', effort: 'high', schema: MERGE_OUT }
				)
			);
			if (!m) return { pr: it.pr, ok: false, why: 'merge agent failed' };
			const v = await limit(() =>
				agent(
					`Verify a conflict resolution. Read only: change nothing, push nothing. Worktree ${WT}/${it.slug} (branch ${it.branch}, PR #${it.pr}); the merge of origin/main is ${m.mergeCommit}${r > 1 ? ' with fix commits after it up to HEAD' : ''}. The resolver says:\n${m.resolution}\nInspect \`git -C ${WT}/${it.slug} show --remerge-diff ${m.mergeCommit}\` (how the conflicts were resolved)${r > 1 ? ` and \`git -C ${WT}/${it.slug} diff ${m.mergeCommit} HEAD\`` : ''}; read both parents' versions of each conflicted file. APPROVE only if both sides' intent survives (no entry, behaviour or test from either side lost, nothing duplicated, the result coherent) and the resolver's checks are real (rerun \`source ${S}/env/${it.slug}.sh && cd ${WT}/${it.slug} && slot pnpm check\` if in doubt). Report verdict and problems.`,
					{ label: `verify-r${r}:#${it.pr}`, phase: 'Review', model: 'opus', effort: 'high', schema: VERIFY_OUT }
				)
			);
			if (v && v.verdict === 'APPROVE') {
				const pushed = await limit(() => agent(`In ${WT}/${it.slug}: \`git push origin ${it.branch}\` (fast-forward; retry network errors up to 4 times). Report the pushed \`git rev-parse HEAD\` or the error.`, { label: `push:#${it.pr}`, phase: 'Body', model: 'haiku', effort: 'low' }));
				return { pr: it.pr, ok: true, merged: m.mergeCommit, pushed, rounds: r };
			}
			feedback = v ? v.problems : 'the verifier gave no reply';
		}
		return { pr: it.pr, ok: false, why: `resolution not verified: ${feedback}` };
	}
	if (it.mode === 'ci') {
		const fix = await limit(() =>
			agent(
				`${ENV(it)}\nPR #${it.pr} (branch ${it.branch}) was reviewed and approved, then CI's E2E job failed. Failing jobs: ${it.failing}\nFirst \`git merge-tree --write-tree origin/main HEAD\`: if main merges cleanly, merge origin/main into the branch (message "Merge main into ${it.branch}") so you test against today's main; if it conflicts, resolve keeping both sides' intent. Read each failing job's log: \`gh run view <run id> --job <job id> --log-failed -R ${RP}\` (ids are in the links), grep for the failing test titles (lines with ✘, "Error:", "expect(") rather than reading it whole; if needed download that job's Playwright report artifact (\`gh api repos/${RP}/actions/runs/<run id>/artifacts\`; \`gh run download <run id> -n <name> -D ${S}/ci/${it.slug} -R ${RP}\`).\nFind the root cause and make the smallest fix in this PR's code or tests. Never skip, weaken or quarantine a test, never raise a timeout or budget. If the failure is not caused by this PR (a flake you can show, infra, or main also fails it), report notOurs with evidence and change nothing except the main merge. Record baseBeforeFix = \`git rev-parse HEAD\` after the main merge and before your fix commit(s).\n${LIGHT_GATES(it)}\nCommit the fix as new commit(s) and \`git push origin ${it.branch}\` (also push if you only merged main). Report cause, fixed, notOurs, baseBeforeFix, head, pushed, checks.`,
				{ label: `fix:#${it.pr}`, phase: 'Fix', effort: 'high', schema: FIX_OUT }
			)
		);
		if (!fix || !fix.pushed) return { pr: it.pr, ok: false, why: 'fixer failed or did not push', fix };
		if (!fix.fixed || fix.head === fix.baseBeforeFix) return { pr: it.pr, ok: true, rerunOnly: true, cause: fix.cause, notOurs: fix.notOurs, head: fix.head };
		it.cause = fix.cause;
		base = fix.baseBeforeFix;
		head = fix.head;
	} else {
		base = it.base;
		head = it.head;
	}
	const rv = await reviewLoop(it, base, head, it.effort);
	log(`#${it.pr}: review ${rv.approved ? `approved in ${rv.rounds}` : `NOT approved (${rv.why})`}`);
	if (!rv.approved) return { pr: it.pr, ok: false, why: rv.why, head: rv.head, ledger: rv.ledger };
	const line = it.mode === 'ci' ? `Fix for the failed E2E run reviewed with sol-review: ${rv.rounds} rounds with Claude Opus 5.5 on ${it.effort}. Sol verdict: approved` : `Reviewed with sol-review: ${rv.rounds} rounds with Claude Opus 5.5 on ${it.effort}. Sol verdict: approved`;
	await bodyLine(it, line);
	return { pr: it.pr, ok: true, head: rv.head, rounds: rv.rounds, cause: it.cause };
}

return await Promise.all(ITEMS.map((it) => doItem(it).catch((e) => ({ pr: it.pr, ok: false, why: String(e) }))));
