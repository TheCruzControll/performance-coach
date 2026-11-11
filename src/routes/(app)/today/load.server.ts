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
	const setup = await loadTodaySetup(ownerId, origin, deps);
	const found = setup?.complete
		? await loadTodayProgram(ownerId, { now, origin }, deps)
		: undefined;
	const plan =
		found?.state === 'active'
			? loadTodayPlan(ownerId, { today: found.today, origin }, deps)
			: undefined;
	return { setup, program: found === undefined ? undefined : (found?.state ?? null), plan };
}
