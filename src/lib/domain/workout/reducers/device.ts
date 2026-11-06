/**
 * The device family, in every kind's table: what only this device knows (DeviceState) and the
 * kit it holds. None of it is ever sent, so none of it touches a row.
 * - goTo and draft: the exercise on screen, and values typed but not confirmed
 * - exercise.add: an exercise added here, at a position no slot holds yet
 * - kit.attach: the whole kit (a workout from another device), or one exercise's previous sets
 * - rest.* and stopwatch.*: through timers.ts, on this device's clock
 * An action that changes nothing returns the state it was given.
 */
import * as timers from '../timers.ts';
import type { LocalAction } from '../mutations.ts';
import type { LocalReducer, LocalReducers, LocalState, LocalType } from '../project.ts';
import type { DeviceState, RestState, StopwatchState } from '../types.ts';

/** A workout's device state before any action: the first exercise, no timer running. */
export function initialDevice(): DeviceState {
	return {
		position: 1,
		drafts: {},
		rest: null,
		stopwatch: timers.STOPWATCH_IDLE,
		added: [],
		attached: {}
	};
}

const withDevice = (local: LocalState, change: Partial<DeviceState>): LocalState => ({
	...local,
	device: { ...local.device, ...change }
});

/** A timer change to the rest, if there is one. */
const onRest =
	<T extends LocalType>(
		change: (rest: RestState, action: LocalAction & { type: T }) => RestState
	): LocalReducer<T> =>
	(local, action) => {
		const rest = local.device.rest && change(local.device.rest, action);
		return rest === local.device.rest ? local : withDevice(local, { rest });
	};

const onStopwatch =
	<T extends LocalType>(change: (stopwatch: StopwatchState, now: number) => StopwatchState) =>
	(local: LocalState, action: LocalAction & { type: T; at: number }): LocalState => {
		const stopwatch = change(local.device.stopwatch, action.at);
		return stopwatch === local.device.stopwatch ? local : withDevice(local, { stopwatch });
	};

/** The positions the kit's exercises and the added ones hold. */
const taken = ({ kit, device }: LocalState) => [
	...(kit?.kind === 'strength' ? kit.exercises.map((e) => e.position) : []),
	...device.added.map((a) => a.position)
];

export const device: LocalReducers = {
	goTo: (local, { position }) =>
		local.device.position === position ? local : withDevice(local, { position }),
	draft: (local, { position, setIndex, draft }) => {
		const key = `${position}:${setIndex}`;
		const { [key]: _cleared, ...drafts } = local.device.drafts;
		return withDevice(local, { drafts: draft === null ? drafts : { ...drafts, [key]: draft } });
	},
	'exercise.add': (local, { exercise }) =>
		taken(local).includes(exercise.position)
			? local
			: withDevice(local, { added: [...local.device.added, exercise] }),
	'kit.attach': (local, action) =>
		'kit' in action
			? { ...local, kit: action.kit }
			: withDevice(local, {
					attached: { ...local.device.attached, [action.exerciseId]: action.previous }
				}),
	'rest.start': (local, { at, durationMs }) =>
		withDevice(local, { rest: timers.startRest(at, durationMs) }),
	'rest.add': onRest((rest, { at, ms }) => timers.addRest(rest, at, ms)),
	'rest.pause': onRest((rest, { at }) => timers.pauseRest(rest, at)),
	'rest.resume': onRest((rest, { at }) => timers.resumeRest(rest, at)),
	'rest.reset': onRest((rest, { at }) => timers.resetRest(rest, at)),
	'rest.skip': onRest((rest, { at }) => timers.skipRest(rest, at)),
	/** Starts a stopwatch that never ran; one already started keeps its time. */
	'stopwatch.start': onStopwatch((stopwatch, now) =>
		stopwatch.startedAt === null ? timers.startStopwatch(now) : stopwatch
	),
	'stopwatch.pause': onStopwatch(timers.pauseStopwatch),
	'stopwatch.resume': onStopwatch(timers.resumeStopwatch),
	'stopwatch.reset': onStopwatch(timers.resetStopwatch)
};
