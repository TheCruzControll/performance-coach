/**
 * Today's page data (+page.server.ts): the setup card, then, once onboarding is complete, whether
 * a program exists, and with one the streamed plan. Kept out of +page.server.ts so db:explain
 * can time it (scripts/explain/screens.cases.ts).
 *
 * The setup card is awaited, not streamed. It is the screen's largest content, and a streamed
 * card only replaces its skeleton after hydration, which put LCP at ~2.8 s. With a program,
 * today's plan (plan.server.ts) is streamed: a client navigation shows Today at once with the
 * plan's skeleton, and the server's own render waits for it in +page.ts, so a document opened on
 * Today paints the plan first.
 *
 * The setup and the program are read together, and the plan starts as soon as the program is
 * found, each service on its own pool connection (docs/architecture.md), so `db` is the pool,
 * never a transaction. Onboarding, once complete, stays complete, and a program is only built
 * after it, so the program read rarely runs for nothing: its answer is used only once the setup
 * says onboarding is complete.
 */
import { loadTodayPlan, type TodayPlanView } from './plan.server';
import { loadTodayProgram, type TodayProgram } from './program.server';
import { loadTodaySetup, type SetupDeps, type SetupOrigin, type TodaySetup } from './setup.server';

export interface TodayData {
	setup: TodaySetup | null;
	/** Undefined until onboarding is complete; null when the program could not be read. */
	program: TodayProgram | null | undefined;
	plan: Promise<TodayPlanView> | undefined;
}

export async function loadToday(
	ownerId: string,
	{ now, origin }: { now: Date; origin: SetupOrigin },
	deps: SetupDeps = {}
): Promise<TodayData> {
	// None of the three rejects: each records its own failure and answers null.
	let plan: Promise<TodayPlanView> | undefined;
	const reading = loadTodayProgram(ownerId, { now, origin }, deps).then((found) => {
		if (found?.program) {
			plan = loadTodayPlan(ownerId, { today: found.today, program: found.program, origin }, deps);
		}
		return found;
	});
	const setup = await loadTodaySetup(ownerId, origin, deps);
	if (!setup?.complete) return { setup, program: undefined, plan: undefined };
	const found = await reading;
	return { setup, program: found?.state ?? null, plan };
}
