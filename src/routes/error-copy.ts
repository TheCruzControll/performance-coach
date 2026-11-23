/**
 * The words of the failure states (ErrorView.svelte), from Paper's `10 · States` (Instrument v2):
 * each says one thing, and offers at most one thing to do. Pure, so the words are unit-tested.
 */
export type ErrorKind = 'offline' | 'not-found' | 'error';

export function errorKind(status: number, error: App.Error | null): ErrorKind {
	if (error?.offline) return 'offline';
	return status === 404 ? 'not-found' : 'error';
}

/** What a state offers: none (it recovers by itself), Try again, or the way home. */
export type StateAction = 'try-again' | 'back-to-today' | null;

export interface StateCopy {
	/** The one red line above the title (an error only). */
	line: string | null;
	title: string;
	body: string;
	action: StateAction;
}

export interface CopyContext {
	/** The screen at this URL ("Progress"), when it is one of the shell's. */
	screen?: string;
	/** null until known (the server render, the prerendered /offline document). */
	deviceOnline: boolean | null;
	/** The /offline document at its own URL: no recovery runs there, so Try again stays. */
	atOfflinePath: boolean;
}

export function errorCopy(kind: ErrorKind, context: CopyContext): StateCopy {
	if (kind === 'not-found')
		return {
			line: null,
			title: 'Nothing here',
			body: 'This page doesn’t exist. Your training is safe.',
			action: 'back-to-today'
		};
	if (kind === 'error')
		return {
			line: 'Something went wrong',
			title: 'That one is on us. Your training is safe',
			body: 'Nothing you logged was lost.',
			action: 'try-again'
		};
	const action: StateAction = context.atOfflinePath ? 'try-again' : null;
	if (context.deviceOnline)
		return {
			line: null,
			title: 'Your connection looks fine. The server isn’t answering',
			body: 'This screen keeps trying and opens by itself when it can.',
			action
		};
	return {
		line: null,
		title: `${context.screen ?? 'This screen'} needs a connection`,
		body: 'It opens by itself when you’re back online. Today and your workout still work.',
		action
	};
}

/** Today's quiet line while offline (Paper, 10 · States, "No signal"): under the title. */
export function offlineLine(deviceOnline: boolean | null): string {
	return deviceOnline
		? 'The server isn’t answering. Your sets are saved on this device.'
		: 'Offline. Your sets are saved on this device.';
}
