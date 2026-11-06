/**
 * What a tool knows about its turn. Every field comes from the server: the owner from the
 * session, the text from the stored owner message, deps and serialTools from the services'
 * toolRuntime(deps). None comes from the model, so no input can say whose data a tool reads
 * (schema.ts refuses any input property that names an owner).
 *
 * The agent never sees the database executor, not even its type (ESLint forbids agent → db): it
 * learns how its tools may run from serialTools, true when the services were handed a
 * transaction, which runs one query at a time (docs/architecture.md). deps reach the services
 * untouched.
 */
import type { SourceRef } from '../../../domain/coach/sources.ts';

/** What services/coach/shared.ts's toolRuntime(deps) returns (coach-threads-service). */
export interface ToolRuntime<Deps> {
	deps: Deps;
	serialTools: boolean;
}

/** Where the owner opened the coach from and about what; coach-entry-points names the entries. */
export interface TurnEntry {
	from: string;
	ref: SourceRef | null;
}

export interface ToolContext<Deps = unknown> {
	readonly ownerId: string;
	readonly threadId: string;
	readonly runId: string;
	/** The owner's local day, YYYY-MM-DD, in their IANA zone. */
	readonly today: string;
	readonly timeZone: string;
	/** The stored owner message the turn answers: where an explicit preference is read from. */
	readonly ownerText: string;
	readonly entry: TurnEntry | null;
	/** Aborts when the turn stops; inside a call, also at the call's deadline. */
	readonly signal: AbortSignal;
	/** When the turn (inside a call, the call) must stop, in epoch milliseconds. */
	readonly deadlineAt: number;
	readonly deps: Deps;
	readonly serialTools: boolean;
	/** M3's matchExercise over the owner's library: an exercise key, or null. */
	readonly matchExercise: (text: string) => string | null;
}

/** The one way a ToolContext is made. */
export function toolContext<Deps>(source: {
	session: { ownerId: string };
	message: { threadId: string; runId: string; text: string; entry: TurnEntry | null };
	day: { today: string; timeZone: string };
	runtime: ToolRuntime<Deps>;
	signal: AbortSignal;
	deadlineAt: number;
	matchExercise: (text: string) => string | null;
}): ToolContext<Deps> {
	const { session, message, day, runtime } = source;
	return Object.freeze({
		ownerId: session.ownerId,
		threadId: message.threadId,
		runId: message.runId,
		today: day.today,
		timeZone: day.timeZone,
		ownerText: message.text,
		entry: message.entry,
		signal: source.signal,
		deadlineAt: source.deadlineAt,
		deps: runtime.deps,
		serialTools: runtime.serialTools,
		matchExercise: source.matchExercise
	});
}
