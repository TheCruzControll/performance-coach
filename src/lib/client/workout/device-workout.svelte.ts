/**
 * The workout in progress on this device, as the resume bar last read it (probe.ts, on idle, on
 * every (app) screen). The resume bar writes it; Today and the session screen read Resume from
 * it (ui/program/start-link.ts resumeLink) instead of loading the probe themselves. Reading it
 * never touches IndexedDB, so those screens stay create-free.
 */
export interface DeviceWorkout {
	/** Null until read, or with no workout in progress. */
	active: {
		/** The planned session it was started from, or null for an ad-hoc workout. */
		plannedLineage: string | null;
		/** Its kind's page (kinds.ts), resolved. */
		href: string;
	} | null;
}

export const deviceWorkout: DeviceWorkout = $state({ active: null });
