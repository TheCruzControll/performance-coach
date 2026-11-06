/**
 * The metrics of an other session (PRD §8, §9): Muay Thai, mobility, S&C and custom sessions
 * track what M3's CustomMetric holds (rounds, sparred), each a number, a short text or a yes/no.
 * The session screen, the Fix flow and the sync endpoint share these rules.
 *
 * - A metric's type is its value's: the plan's template value says how the owner enters it, and
 *   metricInput turns what a field holds into that type ('6' becomes 6).
 * - A planned session takes only its plan's metrics, typed as the plan types them. An ad-hoc
 *   session takes the owner's own, under any key; its shape (snake_case keys, each once, short
 *   labels) is M3's customMetricsSchema's to check, as are lengths and ranges here.
 */
import type { FieldErrors } from '../validation.ts';
import type { CustomMetric } from '../training/types.ts';
import type { OtherKit } from './types.ts';

/** How a metric is entered: a stepper for a number, a toggle for a yes/no, a short text field. */
export type MetricType = 'number' | 'yes_no' | 'text';

const TYPE_WORDS: Readonly<Record<MetricType, string>> = {
	number: 'a number',
	yes_no: 'yes or no',
	text: 'a short text'
};

export function metricType(value: CustomMetric['value']): MetricType {
	return typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'yes_no' : 'text';
}

/** What a field holds: a typed string, a stepper's number, a toggle's boolean. */
export type MetricRaw = string | number | boolean;

export type MetricInput = { ok: true; metric: CustomMetric } | { ok: false; error: string };

/** A plain decimal, as a person types one: no hex, no exponent, no units. */
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

function typed(type: MetricType, raw: MetricRaw): CustomMetric['value'] | null {
	switch (type) {
		case 'number': {
			const text = typeof raw === 'string' ? raw.trim() : null;
			const value = text !== null && DECIMAL.test(text) ? Number(text) : raw;
			return typeof value === 'number' && Number.isFinite(value) ? value : null;
		}
		case 'yes_no':
			return typeof raw === 'boolean' ? raw : null;
		case 'text':
			return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
	}
}

/**
 * The metric with the value a field holds, typed as the metric's own value is (the plan's
 * template, or the owner's metric as they added it), or why that value does not fit.
 */
export function metricInput(metric: CustomMetric, raw: MetricRaw): MetricInput {
	const type = metricType(metric.value);
	const value = typed(type, raw);
	return value === null
		? { ok: false, error: `${metric.label} is ${TYPE_WORDS[type]}` }
		: { ok: true, metric: { ...metric, value } };
}

/**
 * The metrics an other session may record: its plan's (a planned session's kit carries them),
 * or null for an ad-hoc session, which takes the owner's own.
 */
export function metricTemplate(kit: OtherKit): readonly CustomMetric[] | null {
	return kit.plannedSessionId === null ? null : kit.other.metrics;
}

/**
 * Field errors, at dotted paths under `payload.`, for an other.log's metrics the session cannot
 * record: on a planned session, a key its plan lacks or a value of another type than the plan's.
 * Empty when they fit, and always for an ad-hoc session (template null).
 */
export function checkMetrics(
	metrics: readonly CustomMetric[],
	template: readonly CustomMetric[] | null
): FieldErrors {
	const errors: FieldErrors = {};
	if (template === null) return errors;
	metrics.forEach((m, i) => {
		const planned = template.find((t) => t.key === m.key);
		if (!planned) {
			errors[`payload.metrics.${i}.key`] = `${m.label} is not one of this session’s metrics`;
		} else if (metricType(m.value) !== metricType(planned.value)) {
			const type = metricType(planned.value);
			errors[`payload.metrics.${i}.value`] = `${planned.label} is ${TYPE_WORDS[type]}`;
		}
	});
	return errors;
}
