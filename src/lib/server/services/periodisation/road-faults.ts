/**
 * A test fault for Train's road read (m7/39): 'slow' holds the read until the fault is cleared
 * (at most ROAD_FAULT_HOLD_MS, so a spec that forgets cannot hang a server), 'fail' makes it
 * throw, so a spec sees the plan sheet while the season streams, the swap when it is released, and
 * the sheet after a failure. Only the test route (PUT /api/test-support/analytics) sets it, and
 * only where test routes are enabled; where they are not, nothing can set it and the road never
 * reads it, as agent/provider/faults.ts does for the mock coach.
 */
import { testRoutesEnabled } from '../../env.ts';

export const ROAD_FAULTS = ['none', 'slow', 'fail'] as const;
export type RoadFault = (typeof ROAD_FAULTS)[number];

/** The longest 'slow' holds a read. */
export const ROAD_FAULT_HOLD_MS = 10_000;

let current: RoadFault = 'none';
let held: (() => void)[] = [];

export const isRoadFault = (value: unknown): value is RoadFault =>
	ROAD_FAULTS.includes(value as RoadFault);

/** Called by the test route; refused unless test routes are enabled. Releases held reads. */
export function setRoadFault(fault: RoadFault, enabled = testRoutesEnabled()): void {
	if (!enabled) throw new Error('The road fault is set only through the test route');
	current = fault;
	if (fault === 'slow') return;
	for (const release of held) release();
	held = [];
}

/** The fault in force: none unless one was set and test routes are still enabled. */
export function roadFault(enabled: () => boolean = testRoutesEnabled): RoadFault {
	return current !== 'none' && enabled() ? current : 'none';
}

/** Resolves once 'slow' is cleared, or after `ms`. */
export function roadReleased(ms = ROAD_FAULT_HOLD_MS): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(release, ms);
		function release() {
			clearTimeout(timer);
			held = held.filter((r) => r !== release);
			resolve();
		}
		held.push(release);
	});
}
