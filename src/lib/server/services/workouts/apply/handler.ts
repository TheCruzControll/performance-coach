/**
 * What every apply/* module shares: the handler shape the dispatcher (../sync.ts) calls, inside
 * the mutation's own transaction, and the refusal a handler throws for a mutation the server
 * cannot apply yet. A handler writes through M3's services with `deps` (the transaction, and
 * source 'owner' for the audit trail) and throws their errors; the dispatcher turns each into a
 * result.
 */
import type { MutationOf, MutationType } from '../../../../domain/workout/index';
import type { ResolvedTrainingDeps } from '../../training/shared';

export interface ApplyContext {
	ownerId: string;
	/** db is the mutation's transaction: every write commits or rolls back with its ledger row. */
	deps: ResolvedTrainingDeps;
}

export type Handler<T extends MutationType> = (
	m: MutationOf<T>,
	ctx: ApplyContext
) => Promise<void>;

export type Handlers<T extends MutationType> = { [K in T]: Handler<K> };

/** A type whose handler lands in a later slice: rejected 'unsupported', with no ledger row. */
export class UnsupportedMutationError extends Error {
	constructor(type: MutationType) {
		super(`${type} is not supported yet`);
		this.name = 'UnsupportedMutationError';
	}
}

/** Every type of a family, each answered 'unsupported' until its slice replaces the module. */
export function unsupported<T extends MutationType>(types: readonly T[]): Handlers<T> {
	const refuse = async (m: MutationOf<MutationType>) => {
		throw new UnsupportedMutationError(m.type);
	};
	return Object.fromEntries(types.map((type) => [type, refuse])) as unknown as Handlers<T>;
}
