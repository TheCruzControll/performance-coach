/**
 * Unambiguous lookups answered without a model call (the turn's hook; PRD §15: they keep working
 * when the provider is misconfigured). A stub that answers nothing: direct-answers replaces this
 * file. An answer is text in the answer grammar, which the turn parses, checks and stores like a
 * model's.
 */
import type { TurnFacts } from './prompt/context.ts';

export interface DirectInput<Deps> {
	ownerId: string;
	text: string;
	facts: TurnFacts;
	deps: Deps;
}

export async function directAnswer<Deps>(_input: DirectInput<Deps>): Promise<string | null> {
	return null;
}
