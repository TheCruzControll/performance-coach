/**
 * Today's setup card: until onboarding is complete, how far the owner has got and where Continue
 * resumes (the furthest step advanced). Kept out of +page.server.ts so integration tests can run
 * it with an unreachable database.
 *
 * - `done` counts the finished (completed or skipped) steps among those that apply now, and
 *   `total` is every step that applies, review included, as onboarding's own progress counts.
 * - Once it is complete, what Today summarises instead: the open goals by rank, and the shape of
 *   the week (how many days and how long, which days, the commitments already in it). Words are
 *   built here so the page ships none of the catalogue; only the countdown to each goal's date is
 *   left to the page, which counts from the device's date after hydration.
 * - It fails soft: a read that fails is recorded as a server error (kind 'load') and the card
 *   shows its designed error with Retry, inside the shell, instead of the 500 page.
 */
import { DISCIPLINE_INFO, WEEKDAYS, type DisciplineTone } from '#lib/domain/profile/catalog.ts';
import type { OnboardingStep } from '#lib/domain/profile/onboarding.ts';
import type { Goal, Schedule } from '#lib/domain/profile/types.ts';
import { recordServerError, type ServerErrorInput } from '#lib/server/services/errors.ts';
import {
	getOnboarding,
	getSchedule,
	listGoals,
	type ProfileDeps
} from '#lib/server/services/profile/index.ts';
import { commitmentSummary, daysText, scheduleSummary } from '#lib/ui/profile/schedule.ts';

export interface TodayGoal {
	id: string;
	title: string;
	/** The event's date, or a general goal's target date: what the countdown counts to. */
	date: string | null;
	/** Paused goals keep their rank; the page marks them as Profile does. */
	paused: boolean;
	disciplines: { name: string; tone: DisciplineTone }[];
}

export interface TodayWeek {
	/** "4 days a week · 60 min sessions", or null until the days are set. */
	summary: string | null;
	/** "Mon, Tue, Thu, Sat", or null when no days are picked. */
	available: string | null;
	commitments: { id: string; label: string; when: string; tone: DisciplineTone }[];
	/** Monday first: whether the day is free to train, and what is already booked on it. */
	days: { available: boolean; booked: { label: string; tone: DisciplineTone }[] }[];
}

export type TodaySetup =
	| { complete: true; goals: TodayGoal[]; week: TodayWeek }
	| { complete: false; done: number; total: number; next: OnboardingStep };

export type SetupOrigin = Pick<
	ServerErrorInput,
	'requestId' | 'method' | 'path' | 'routeId' | 'appVersion'
>;

export interface SetupDeps extends Pick<ProfileDeps, 'db'> {
	/** Where a failure is recorded (app_errors): the app's database unless given. */
	errorsDb?: ProfileDeps['db'];
}

export async function loadTodaySetup(
	ownerId: string,
	origin: SetupOrigin,
	{ db, errorsDb }: SetupDeps = {}
): Promise<TodaySetup | null> {
	try {
		const { complete, steps, progress, resume } = await getOnboarding(ownerId, { db });
		if (complete) {
			// One query at a time on the one handle (docs/architecture.md).
			const goals = await listGoals(ownerId, { db });
			const schedule = await getSchedule(ownerId, { db });
			return { complete: true, goals: todayGoals(goals), week: todayWeek(schedule) };
		}
		const finished = new Set([...progress.completed, ...progress.skipped]);
		return {
			complete: false,
			done: steps.filter((step) => finished.has(step)).length,
			total: steps.length,
			next: resume
		};
	} catch (error) {
		await recordServerError(
			{ error, kind: 'load', status: 500, ...origin, context: { load: 'todaySetup' } },
			{ db: errorsDb }
		);
		return null;
	}
}

/** Open goals, by rank as listGoals returns them (achieved and dropped goals hold none). */
function todayGoals(goals: Goal[]): TodayGoal[] {
	return goals
		.filter((g) => g.priority !== null)
		.map((g) => ({
			id: g.id,
			title: g.title,
			date: g.kind === 'event' ? g.eventDate : g.targetDate,
			paused: g.status === 'paused',
			// As the chips name them: the short form, a custom one by its own label.
			disciplines: g.disciplines.map((d) => ({
				name: d === 'custom' && g.customDiscipline ? g.customDiscipline : DISCIPLINE_INFO[d].short,
				tone: DISCIPLINE_INFO[d].tone
			}))
		}));
}

function todayWeek(schedule: Schedule): TodayWeek {
	const commitments = schedule.commitments.map((c) => ({
		id: c.id,
		label: c.label,
		when: commitmentSummary(c),
		tone: DISCIPLINE_INFO[c.discipline].tone
	}));
	return {
		summary: schedule.daysPerWeek ? scheduleSummary(schedule) : null,
		available: schedule.availableDays.length ? daysText(schedule.availableDays) : null,
		commitments,
		days: WEEKDAYS.map((day) => ({
			available: schedule.availableDays.includes(day),
			booked: schedule.commitments
				.filter((c) => c.days.includes(day))
				.map((c) => ({ label: c.label, tone: DISCIPLINE_INFO[c.discipline].tone }))
		}))
	};
}
