/**
 * Cold or warm: whether a request is the first this server process has handled.
 *
 * On Vercel each function instance is one Node process, so its first request paid for the
 * instance's start (and usually a fresh database connection). The access log and the
 * Server-Timing header carry the flag, so a slow response in production can be put down to a
 * cold start, or ruled out, from the log line or the probe's output alone
 * (.github/workflows/production-probe.yml).
 */

export type InstanceStart = 'cold' | 'warm';

export interface InstanceNote {
	start: InstanceStart;
	/** Milliseconds since this process started (Node's `performance.timeOrigin`). */
	instanceAgeMs: number;
}

export interface InstanceTracker {
	/** Call once per request, when it arrives. */
	note(now?: number): InstanceNote;
}

export function createInstanceTracker(): InstanceTracker {
	let served = 0;
	return {
		note(now = performance.now()) {
			served += 1;
			return {
				start: served === 1 ? 'cold' : 'warm',
				instanceAgeMs: Math.round(now)
			};
		}
	};
}

/** This process's tracker. */
export const instance = createInstanceTracker();
