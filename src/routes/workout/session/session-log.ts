/**
 * The other-session view's rules (PRD §8), pure, so the page, its Fix editor and the tests agree:
 * - what the fields start from: the session's record once it has one, else the plan's type and
 *   metrics (the plan's values are the starting values) and the stopwatch's minutes
 * - the fields as shown: that start with the device's draft over it (DeviceState.session), so a
 *   reload restores what was changed but not saved
 * - Save: every value, checked first (each metric typed as it was planned or added, through
 *   domain/workout/other.ts), sent as one other.log with the draft cleared in the same dispatch;
 *   the first creates the record, a later one edits it with absolute values (the M4 plan's
 *   decision 8)
 * - the owner's own metrics: on an ad-hoc session only, a name made into a snake_case key, as
 *   M3's customMetricsSchema asks
 * - the server's errors, by field, a metric's under its key, so they stay with it when another
 *   metric is removed
 */
import type { CustomMetric } from '#lib/domain/training/types.ts';
import type { OtherSessionKind } from '#lib/domain/training/vocabulary.ts';
import type { FieldErrors } from '#lib/domain/validation.ts';
import type { LocalAction, Mutation, OtherFields, WorkoutView } from '#lib/domain/workout/index.ts';
import { createMutation } from '#lib/domain/workout/mutations.ts';
import { metricInput, metricTemplate, type MetricType } from '#lib/domain/workout/other.ts';
import { startStopwatch, stopwatchElapsed } from '#lib/domain/workout/timers.ts';

/**
 * Each type in words: the vocabulary's OTHER_SESSION_KIND_LABEL, which a unit test holds this to.
 * Kept here so the vocabulary's other tables stay out of /workout/session's initial JavaScript.
 */
export const KIND_WORDS: Readonly<Record<OtherSessionKind, string>> = {
	pad_work: 'Pad work',
	sparring: 'Sparring',
	technical: 'Technical',
	conditioning: 'Conditioning',
	class: 'Class',
	mobility: 'Mobility',
	strength_conditioning: 'S&C',
	custom: 'Custom'
};

/** A session's effort, 1 to 10 (M3's session RPE): a mobility session is a 2 or 3. */
export const SESSION_RPE_CHIPS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** M3's RECORD_LIMITS.otherMinutes, which a unit test holds this to (the schemas stay lazy). */
export const SESSION_MINUTES = [1, 600] as const;

/** M3's customMetricsSchema: at most 20 metrics, a label up to 40 characters, a text up to 80. */
export const METRIC_LIMITS = { count: 20, label: 40, text: 80 } as const;

/** A field's error: 'durationMinutes', 'kind', 'rpe', 'notes', or `metric:<key>`. */
export type SessionErrors = Partial<Record<string, string>>;

export const metricField = (key: string) => `metric:${key}`;

/** The session's minutes by the stopwatch (from the start when it never ran), within M3's range. */
export function stopwatchMinutes(view: WorkoutView, now: number): number {
	const { stopwatch } = view.device;
	const running =
		stopwatch.startedAt === null ? startStopwatch(Date.parse(view.workout.startedAt)) : stopwatch;
	const minutes = Math.round(stopwatchElapsed(running, now) / 60_000);
	return Math.min(SESSION_MINUTES[1], Math.max(SESSION_MINUTES[0], minutes));
}

/** What the fields start from: the record, else the plan's type and metrics and the stopwatch. */
export function startValues(view: WorkoutView, now: number): OtherFields {
	if (view.other) {
		const { kind, durationMinutes, rpe, metrics, notes } = view.other;
		return { kind, durationMinutes, rpe, metrics, notes };
	}
	const plan = view.kit?.kind === 'other' ? view.kit.other : null;
	return {
		kind: plan?.kind ?? 'custom',
		durationMinutes: stopwatchMinutes(view, now),
		rpe: null,
		metrics: plan?.metrics ?? [],
		notes: null
	};
}

/** The fields as shown: the start, with what this device changed and has not saved over it. */
export const shownValues = (view: WorkoutView, now: number): OtherFields => ({
	...startValues(view, now),
	...view.device.session
});

/**
 * The metrics a planned session may record, or null for an ad-hoc one, which takes the owner's
 * own. The workout row decides (a start kept unplanned is ad hoc); a planned session whose kit
 * this device lacks takes none it does not already have.
 */
export function templateOf(view: WorkoutView): readonly CustomMetric[] | null {
	if (view.workout.plannedSessionId === null) return null;
	return view.kit?.kind === 'other' ? (metricTemplate(view.kit) ?? []) : [];
}

/** A metric the session may drop: any on an ad-hoc session, else one its plan does not have. */
export const removable = (template: readonly CustomMetric[] | null, key: string) =>
	template === null || !template.some((t) => t.key === key);

const notesOf = (notes: string | null) => notes?.trim() || null;

/** Whether the fields differ from the record; always true before the first Save. */
export function unsaved(view: WorkoutView, values: OtherFields): boolean {
	if (!view.other) return true;
	const comparable = ({ kind, durationMinutes, rpe, metrics, notes }: OtherFields) =>
		JSON.stringify([kind, durationMinutes, rpe, metrics, notesOf(notes)]);
	return comparable(view.other) !== comparable(values);
}

/** A metric's value typed as its plan's is, or (the owner's own) as it was added. */
function typedMetric(m: CustomMetric, template: readonly CustomMetric[] | null) {
	const planned = template?.find((t) => t.key === m.key);
	return metricInput(planned ? { ...m, value: planned.value } : m, m.value);
}

/** What Save would refuse here, by field; empty when every value can go. */
export function checkValues(
	values: OtherFields,
	template: readonly CustomMetric[] | null = null
): SessionErrors {
	const errors: SessionErrors = {};
	const [min, max] = SESSION_MINUTES;
	const minutes = values.durationMinutes;
	if (!Number.isInteger(minutes) || minutes < min || minutes > max) {
		errors.durationMinutes = `Between ${min} and ${max} minutes`;
	}
	for (const metric of values.metrics) {
		const input = typedMetric(metric, template);
		if (!input.ok) errors[metricField(metric.key)] = input.error;
	}
	return errors;
}

export type SaveResult =
	{ ok: true; actions: [Mutation, LocalAction] } | { ok: false; errors: SessionErrors };

/** Save: the other.log of every value, and the draft cleared; or what is wrong, by field. */
export function saveActions(view: WorkoutView, values: OtherFields, at: string): SaveResult {
	const template = templateOf(view);
	const errors = checkValues(values, template);
	if (Object.keys(errors).length > 0) return { ok: false, errors };
	const workoutId = view.workout.id;
	const log = logMutation(workoutId, values, at, template);
	return { ok: true, actions: [log, clearDraft(workoutId)] };
}

/** One other.log with every value, typed and trimmed; checkValues has passed. */
export function logMutation(
	workoutId: string,
	values: OtherFields,
	at: string,
	template: readonly CustomMetric[] | null = null
): Mutation {
	const metrics = values.metrics.map((m) => {
		const input = typedMetric(m, template);
		return input.ok ? input.metric : m;
	});
	const { kind, durationMinutes, rpe } = values;
	const payload = { kind, durationMinutes, rpe, metrics, notes: notesOf(values.notes) };
	return createMutation('other.log', { workoutId, at, payload });
}

export const clearDraft = (workoutId: string): LocalAction => ({
	type: 'session.draft',
	workoutId,
	draft: null
});

/** The server's refusal by field: `payload.metrics.1.key` is that metric's, by its key. */
export function serverErrors(errors: FieldErrors, metrics: readonly CustomMetric[]): SessionErrors {
	const out: SessionErrors = {};
	for (const [path, message] of Object.entries(errors)) {
		const [field = path, index] = path.replace(/^payload\./, '').split('.');
		const metric = field === 'metrics' && index !== undefined ? metrics[Number(index)] : undefined;
		out[metric ? metricField(metric.key) : field] = message;
	}
	return out;
}

// ---- The owner's own metrics ----------------------------------------------------------------

/** A metric's name as a snake_case key: 'Bike calories' is bike_calories. */
export function keyOf(label: string): string {
	const words = label
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	const key = words.join('_');
	return (/^[0-9]/.test(key) ? `metric_${key}` : key).slice(0, 40).replace(/_+$/, '');
}

/** A new metric's starting value, by how it is entered. */
const STARTING: Readonly<Record<MetricType, CustomMetric['value']>> = {
	number: 0,
	yes_no: false,
	text: ''
};

export type AddResult = { ok: true; metrics: CustomMetric[] } | { ok: false; error: string };

/** The metrics with the owner's new one after them, or why it cannot be added. */
export function addMetric(
	metrics: readonly CustomMetric[],
	name: string,
	type: MetricType
): AddResult {
	const label = name.trim();
	if (label === '') return { ok: false, error: 'Name the metric' };
	if (label.length > METRIC_LIMITS.label) {
		return { ok: false, error: `Up to ${METRIC_LIMITS.label} characters` };
	}
	const key = keyOf(label);
	if (key === '') return { ok: false, error: 'Use letters or numbers in the name' };
	if (metrics.some((m) => m.key === key)) return { ok: false, error: `${label} is already here` };
	if (metrics.length >= METRIC_LIMITS.count) {
		return { ok: false, error: `Up to ${METRIC_LIMITS.count} metrics` };
	}
	return { ok: true, metrics: [...metrics, { key, label, unit: null, value: STARTING[type] }] };
}
