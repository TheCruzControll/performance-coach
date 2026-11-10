/**
 * A declared lifecycle: a typed transition table that sits next to the closed status list it is
 * keyed on, so the states a record can be in, and what may follow what, live in one place rather
 * than in if-chains around status strings.
 *
 *     const DOOR = defineLifecycle<DoorState, DoorEvent>({ id: 'door', states, on: { ... } });
 *     const moved = step(DOOR, 'closed', 'open'); // { ok: true, t } or the legal events
 *
 * - `on` is a mapped type over the events, so an event without an edge fails `pnpm check` (the
 *   same trick as `ReducerTable` in workout/project.ts).
 * - A status writer takes a `Transitioned<S>`, which only `step()` and `unchecked()` make, so it
 *   cannot skip the table. At runtime it is a frozen plain object; the brand is type-only.
 * - `certainty: 'unknown'` (not proven from code) and `legacy: true` (allowed today, meant to go)
 *   stay separate: an unverified edge and known debt are different things.
 * - `checkLifecycle()` reports unknown states, non-legacy exits from a terminal state and states
 *   no edge reaches; `lifecycleRows()` is what `docs/lifecycles.md` is generated from.
 *
 * Pure and isomorphic: no I/O, no framework, so browser, server and scripts share it.
 */

export interface Edge<S extends string> {
	readonly from: readonly S[];
	readonly to: S;
	/** Plain-language side effects: 'stamps closed_at', 'outbox: delete', 'unknown: cross-tab order'. */
	readonly effects: readonly string[];
	/** Not proven from code; rendered as `unknown` in docs/lifecycles.md. */
	readonly certainty?: 'unknown';
	/** Allowed today, intended to go; the guard reports it. */
	readonly legacy?: true;
	readonly why?: string;
}

export interface Lifecycle<S extends string, E extends string> {
	readonly id: string;
	readonly storedIn: string;
	readonly writeSites: readonly string[];
	readonly tests: readonly string[];
	readonly states: readonly S[];
	readonly initial: readonly S[];
	readonly terminal: readonly S[];
	/** Mapped type: an event without an edge fails pnpm check (the ReducerTable trick). */
	readonly on: { readonly [K in E]: Edge<S> };
}

declare const transitioned: unique symbol;

/** Only step() and unchecked() make one, so a status writer that takes it cannot skip the table. */
export interface Transitioned<S extends string> {
	readonly machine: string;
	readonly from: S;
	readonly to: S;
	readonly event: string;
	readonly legal: boolean;
	readonly [transitioned]: true;
}

export type Step<S extends string, E extends string> =
	| { readonly ok: true; readonly t: Transitioned<S>; readonly legacy: boolean }
	| {
			readonly ok: false;
			readonly machine: string;
			readonly from: S;
			readonly event: E;
			readonly legal: E[];
	  };

/** One table row of docs/lifecycles.md: one `from` state of one event. */
export interface LifecycleRow {
	from: string;
	event: string;
	to: string;
	effects: string;
	certainty: 'known' | 'unknown';
	legacy: boolean;
	why: string;
}

/** Identity: it only fixes the table's types, so a missing event fails the type check. */
export function defineLifecycle<S extends string, E extends string>(
	l: Lifecycle<S, E>
): Lifecycle<S, E> {
	return l;
}

const eventsOf = <S extends string, E extends string>(l: Lifecycle<S, E>): E[] =>
	Object.keys(l.on) as E[];

const brand = <S extends string>(
	machine: string,
	from: S,
	to: S,
	event: string,
	legal: boolean
): Transitioned<S> => Object.freeze({ machine, from, to, event, legal }) as Transitioned<S>;

/** The move `event` makes from `from`, or a refusal naming the events that state allows. */
export function step<S extends string, E extends string>(
	l: Lifecycle<S, E>,
	from: S,
	event: E
): Step<S, E> {
	const edge = l.on[event];
	if (!edge.from.includes(from)) {
		return { ok: false, machine: l.id, from, event, legal: legalEvents(l, from) };
	}
	return { ok: true, t: brand(l.id, from, edge.to, event, true), legacy: edge.legacy === true };
}

/**
 * The move `event` makes from `from`, branded whether or not the table allows it; `legal` says
 * which. For a writer that must go ahead while its machine is only observed.
 */
export function unchecked<S extends string, E extends string>(
	l: Lifecycle<S, E>,
	from: S,
	event: E
): Transitioned<S> {
	const edge = l.on[event];
	return brand(l.id, from, edge.to, event, edge.from.includes(from));
}

/** The events `from` allows, in the table's order. */
export function legalEvents<S extends string, E extends string>(l: Lifecycle<S, E>, from: S): E[] {
	return eventsOf(l).filter((event) => l.on[event].from.includes(from));
}

/** One row per event and `from` state: the table's event order, then each edge's `from` order. */
export function lifecycleRows<S extends string, E extends string>(
	l: Lifecycle<S, E>
): LifecycleRow[] {
	return eventsOf(l).flatMap((event) => {
		const edge = l.on[event];
		return edge.from.map((from) => ({
			from,
			event,
			to: edge.to,
			effects: edge.effects.join('; '),
			certainty: edge.certainty ?? 'known',
			legacy: edge.legacy === true,
			why: edge.why ?? ''
		}));
	});
}

/**
 * The table's problems, one message each, naming the state: a value that is not one of `states`,
 * a non-legacy exit from a terminal state, a state not reachable from `initial`. [] when sound.
 */
export function checkLifecycle<S extends string, E extends string>(l: Lifecycle<S, E>): string[] {
	const states = new Set<string>(l.states);
	const problems: string[] = [];
	const known = (state: S, where: string) => {
		if (!states.has(state)) problems.push(`${l.id}: ${where} ${state} is not a state`);
	};
	for (const state of l.initial) known(state, 'initial');
	for (const state of l.terminal) known(state, 'terminal');
	for (const event of eventsOf(l)) {
		const edge = l.on[event];
		for (const from of edge.from) known(from, `${event} from`);
		known(edge.to, `${event} to`);
	}

	for (const event of eventsOf(l)) {
		const edge = l.on[event];
		if (edge.legacy) continue;
		for (const from of edge.from) {
			if (l.terminal.includes(from)) {
				problems.push(`${l.id}: terminal state ${from} has a non-legacy exit, ${event}`);
			}
		}
	}

	const reached = new Set<S>(l.initial);
	for (let grew = true; grew;) {
		grew = false;
		for (const event of eventsOf(l)) {
			const edge = l.on[event];
			if (!reached.has(edge.to) && edge.from.some((from) => reached.has(from))) {
				reached.add(edge.to);
				grew = true;
			}
		}
	}
	for (const state of l.states) {
		if (!reached.has(state)) problems.push(`${l.id}: ${state} is not reachable from initial`);
	}
	return problems;
}

/** A refused move, thrown where a machine is enforced (or observed under LIFECYCLE_STRICT). */
export class IllegalTransitionError extends Error {
	readonly code = 'illegal_transition';
	readonly machine: string;
	readonly from: string;
	readonly event: string;
	readonly legal: string[];

	constructor(refusal: { machine: string; from: string; event: string; legal: readonly string[] }) {
		super(`${refusal.machine}: ${refusal.from} does not allow ${refusal.event}`);
		this.name = 'IllegalTransitionError';
		this.machine = refusal.machine;
		this.from = refusal.from;
		this.event = refusal.event;
		this.legal = [...refusal.legal];
	}
}
