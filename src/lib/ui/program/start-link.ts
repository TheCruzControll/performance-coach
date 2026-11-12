/**
 * A planned session's way into its workout (PRD §7; the M4 plan's start-entry-points), composed
 * on the server for Today's sessions and the session screen, so neither ships the rule:
 * - 'Start workout' to /workout?start=<lineage>, which starts it from the server's kit, or from
 *   one this device saved when there is no signal (client/workout/start.ts);
 * - 'Done · View' once completed, to its newest workout's History detail (History's list when
 *   none is found);
 * - nothing once skipped.
 * The screens swap in 'Resume' (resumeLink) when it is the workout in progress on the device,
 * which only the browser knows (client/workout/device-workout.svelte.ts).
 */
import type { SessionStatus } from '../../domain/training/vocabulary';

export interface StartLink {
	/** Its test id, by what it does. */
	id: 'start-workout' | 'resume-workout' | 'done-workout';
	label: string;
	href: string;
	/** Done reads as done (a check, the quiet style); the others lead on (play, the accent). */
	icon: 'play' | 'check';
}

/** `workoutId`: the client id of its newest completed workout, when it is completed. */
export function startLink(
	session: { lineage: string; status: SessionStatus },
	workoutId?: string
): StartLink | null {
	if (session.status === 'skipped') return null;
	if (session.status === 'completed') {
		const href = workoutId ? `/progress/workouts/${workoutId}` : '/progress/workouts';
		return { id: 'done-workout', label: 'Done · View', href, icon: 'check' };
	}
	const href = `/workout?start=${encodeURIComponent(session.lineage)}`;
	return { id: 'start-workout', label: 'Start workout', href, icon: 'play' };
}

/** The device's workout in progress, as the resume bar read it. */
export interface DeviceActive {
	/** The planned session it was started from, or null for an ad-hoc workout. */
	plannedLineage: string | null;
	/** Its kind's page. */
	href: string;
}

/** Resume, in place of `link`, when the device's workout in progress is this session's. */
export function resumeLink(
	lineage: string,
	link: StartLink | null,
	active: DeviceActive | null
): StartLink | null {
	if (!link || active?.plannedLineage !== lineage) return link;
	return { id: 'resume-workout', label: 'Resume', href: active.href, icon: 'play' };
}

/**
 * The one session of a day whose way in leads (Today's primary button): the workout in progress
 * (Resume), else the first session still to start. The others' Start is a quiet trailing link,
 * so the day has one call to action. Null when nothing is left to start or resume.
 */
export function leadLineage(
	ways: readonly { lineage: string; link: StartLink | null }[]
): string | null {
	const lead =
		ways.find((w) => w.link?.id === 'resume-workout') ??
		ways.find((w) => w.link?.id === 'start-workout');
	return lead?.lineage ?? null;
}
