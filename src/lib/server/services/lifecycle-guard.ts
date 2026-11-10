/**
 * The server's lifecycle guard: every status write that goes through `transition()` is checked
 * against its machine's table (src/lib/domain/lifecycles.ts) before it happens.
 *
 * - An enforced machine throws `IllegalTransitionError` on a move its table does not allow.
 * - An observed machine logs the move as `lifecycle.observed` and lets it through, branded not
 *   legal, so the code keeps today's behaviour while the logs show where table and code differ.
 *   Under `LIFECYCLE_STRICT=1` (set for Vitest, integration and the e2e server; unset in
 *   production) it throws instead, so a test run catches that drift.
 * - A legacy edge (allowed today, meant to go) is allowed and logged on either kind of machine.
 *
 * Which machines are enforced is a code constant, not an environment variable, so flipping one is
 * a reviewed change.
 */
import { IllegalTransitionError, step, unchecked } from '../../domain/lifecycle';
import type { Lifecycle, Transitioned } from '../../domain/lifecycle';
import { logger } from '../observability/logger';

/**
 * Per machine: enforce (throw on an illegal move) or observe (log; throw only under
 * LIFECYCLE_STRICT). Flipping one is a reviewed PR. An id missing here is observed.
 *
 * - `workout`: enforced, though nothing calls `transition(WORKOUT, …)` yet: its writers check
 *   `canEnd` (src/lib/domain/workout/ends.ts) and absorb an illegal end instead of throwing.
 * - `proposal`: observed; Postgres (drizzle/0026) enforces the same table.
 */
export const ENFORCE = { workout: true, proposal: false } as const;

/** The move `event` makes from `from`, checked against the machine's table (see the module doc). */
export function transition<S extends string, E extends string>(
	l: Lifecycle<S, E>,
	from: S,
	event: E
): Transitioned<S> {
	const moved = step(l, from, event);
	if (moved.ok) {
		if (moved.legacy) {
			logger.warn('lifecycle.observed', { machine: l.id, from, event, legacy: true });
		}
		return moved.t;
	}

	const enforced = (ENFORCE as Readonly<Record<string, boolean>>)[l.id] === true;
	if (enforced) throw new IllegalTransitionError(moved);
	logger.warn('lifecycle.observed', {
		machine: l.id,
		from,
		event,
		legacy: false,
		legal: moved.legal
	});
	if (process.env.LIFECYCLE_STRICT === '1') throw new IllegalTransitionError(moved);
	return unchecked(l, from, event);
}
