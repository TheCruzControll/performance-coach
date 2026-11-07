/**
 * Which provider answers the coach, decided from the environment. A misconfiguration never stops
 * the server: it makes the coach unavailable, and the rest of the app works as before.
 *
 * Any environment:
 * - LLM_PROVIDER=off: disabled. The owner's kill switch, effective at the next deploy.
 *
 * Production:
 * - not launched (COACH_LAUNCHED, launch.ts): not_launched, before any key check
 * - unset or 'anthropic': anthropic with a key, no_key without one
 * - 'mock': mock_in_production (the mock never answers the owner for real)
 *
 * Development, test and preview (a preview is only ever a manual deploy):
 * - unset or 'mock': the mock, shown with a 'Mock coach' badge
 * - 'anthropic': anthropic with a key, no_key without one
 *
 * not_launched and disabled refuse every turn. no_key and mock_in_production are
 * misconfigurations: they log one warning, and direct answers (lookups that need no model) keep
 * working.
 */
import type { Env } from '../../env.ts';
import { logger } from '../../observability/logger.ts';
import { COACH_LAUNCHED } from '../launch.ts';

export type CoachProviderName = 'mock' | 'anthropic';

export const COACH_UNAVAILABLE_REASONS = [
	'disabled',
	'not_launched',
	'no_key',
	'mock_in_production'
] as const;
export type CoachUnavailableReason = (typeof COACH_UNAVAILABLE_REASONS)[number];

export type CoachProviderChoice =
	| { status: 'ready'; provider: CoachProviderName; mockBadge: boolean }
	| { status: 'unavailable'; reason: CoachUnavailableReason };

export type CoachProviderEnv = Pick<Env, 'appEnv' | 'LLM_PROVIDER' | 'ANTHROPIC_API_KEY'>;

type Warn = (msg: string, fields: Record<string, unknown>) => void;

/** Misconfigurations, as opposed to a deliberate off or the launch switch: they log a warning. */
export function isMisconfiguration(reason: CoachUnavailableReason): boolean {
	return reason === 'no_key' || reason === 'mock_in_production';
}

/**
 * The unavailable reasons that still serve direct answers (lookups that need no model call), so
 * a misconfiguration never takes the owner's numbers away (PRD §15). Owner decision (kill
 * switch): 'off' refuses them too; add 'disabled' here to keep lookups while the coach is off.
 */
export const DIRECT_ANSWER_REASONS: readonly CoachUnavailableReason[] = [
	'no_key',
	'mock_in_production'
];

function choose(env: CoachProviderEnv, launched: boolean): CoachProviderChoice {
	const unavailable = (reason: CoachUnavailableReason) =>
		({ status: 'unavailable', reason }) as const;
	const ready = (provider: CoachProviderName) =>
		({ status: 'ready', provider, mockBadge: provider === 'mock' }) as const;
	const hasKey = Boolean(env.ANTHROPIC_API_KEY?.trim());

	if (env.LLM_PROVIDER === 'off') return unavailable('disabled');
	if (env.appEnv === 'production') {
		if (!launched) return unavailable('not_launched');
		if (env.LLM_PROVIDER === 'mock') return unavailable('mock_in_production');
		return hasKey ? ready('anthropic') : unavailable('no_key');
	}
	if (env.LLM_PROVIDER === 'anthropic') return hasKey ? ready('anthropic') : unavailable('no_key');
	return ready('mock');
}

/**
 * The coach's provider for `env`. Call it once per server (the coach's composition root): a
 * misconfiguration logs one warning naming the variable, never its value.
 */
export function resolveCoachProvider(
	env: CoachProviderEnv,
	launched: boolean = COACH_LAUNCHED,
	warn: Warn = logger.warn
): CoachProviderChoice {
	const choice = choose(env, launched);
	if (choice.status === 'unavailable' && isMisconfiguration(choice.reason)) {
		warn('coach unavailable: provider misconfigured', {
			reason: choice.reason,
			appEnv: env.appEnv,
			variable: choice.reason === 'no_key' ? 'ANTHROPIC_API_KEY' : 'LLM_PROVIDER'
		});
	}
	return choice;
}
