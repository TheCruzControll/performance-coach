import { describe, expect, it, vi } from 'vitest';
import { APP_ENVS, parseEnv, type AppEnv } from '../../env.ts';
import { COACH_LAUNCHED } from '../launch.ts';
import {
	COACH_UNAVAILABLE_REASONS,
	DIRECT_ANSWER_REASONS,
	isMisconfiguration,
	resolveCoachProvider,
	type CoachProviderChoice,
	type CoachProviderEnv
} from './select.ts';

const PROVIDERS = [undefined, 'mock', 'anthropic', 'off'] as const;
const KEYS = [undefined, '', '   ', 'sk-ant-example-key'] as const;
const KEY = 'sk-ant-example-key';

const anthropic: CoachProviderChoice = { status: 'ready', provider: 'anthropic', mockBadge: false };
const mock: CoachProviderChoice = { status: 'ready', provider: 'mock', mockBadge: true };
const unavailable = (reason: string) => ({ status: 'unavailable', reason });

/** The decision table, written out independently of select.ts. */
function expected(
	appEnv: AppEnv,
	provider: (typeof PROVIDERS)[number],
	key: (typeof KEYS)[number],
	launched: boolean
) {
	const hasKey = key === KEY;
	if (provider === 'off') return unavailable('disabled');
	if (appEnv === 'production') {
		if (!launched) return unavailable('not_launched');
		if (provider === 'mock') return unavailable('mock_in_production');
		return hasKey ? anthropic : unavailable('no_key');
	}
	if (provider === 'anthropic') return hasKey ? anthropic : unavailable('no_key');
	return mock;
}

function resolve(env: CoachProviderEnv, launched: boolean) {
	const warn = vi.fn();
	return { choice: resolveCoachProvider(env, launched, warn), warn };
}

describe('resolveCoachProvider', () => {
	it('ships with the coach not launched: only coach-launch flips it', () => {
		expect(COACH_LAUNCHED).toBe(false);
		const { choice } = resolve({ appEnv: 'production', ANTHROPIC_API_KEY: KEY }, COACH_LAUNCHED);
		expect(choice).toEqual(unavailable('not_launched'));
	});

	it('defaults `launched` to the shipped constant', () => {
		const env: CoachProviderEnv = { appEnv: 'production', ANTHROPIC_API_KEY: KEY };
		expect(resolveCoachProvider(env, undefined, vi.fn())).toEqual(unavailable('not_launched'));
	});

	describe('every combination of environment, key, LLM_PROVIDER and launch', () => {
		for (const appEnv of APP_ENVS)
			for (const LLM_PROVIDER of PROVIDERS)
				for (const ANTHROPIC_API_KEY of KEYS)
					for (const launched of [true, false]) {
						const want = expected(appEnv, LLM_PROVIDER, ANTHROPIC_API_KEY, launched);
						it(`${appEnv}, LLM_PROVIDER=${LLM_PROVIDER ?? '(unset)'}, key=${JSON.stringify(ANTHROPIC_API_KEY)}, launched=${launched} → ${'reason' in want ? want.reason : want.provider}`, () => {
							const { choice, warn } = resolve(
								{ appEnv, LLM_PROVIDER, ANTHROPIC_API_KEY },
								launched
							);
							expect(choice).toEqual(want);
							const misconfigured =
								choice.status === 'unavailable' && isMisconfiguration(choice.reason);
							expect(warn).toHaveBeenCalledTimes(misconfigured ? 1 : 0);
						});
					}
	});

	it('production, not launched, with a key → not_launched, before any key check', () => {
		for (const LLM_PROVIDER of [undefined, 'anthropic', 'mock'] as const) {
			for (const ANTHROPIC_API_KEY of [KEY, undefined]) {
				const { choice, warn } = resolve(
					{ appEnv: 'production', LLM_PROVIDER, ANTHROPIC_API_KEY },
					false
				);
				expect(choice).toEqual(unavailable('not_launched'));
				expect(warn).not.toHaveBeenCalled();
			}
		}
	});

	it('production, launched, unset, with a key → anthropic; without one → no_key', () => {
		expect(resolve({ appEnv: 'production', ANTHROPIC_API_KEY: KEY }, true).choice).toEqual(
			anthropic
		);
		expect(resolve({ appEnv: 'production' }, true).choice).toEqual(unavailable('no_key'));
	});

	it("production, launched, 'mock' → mock_in_production, even with a key", () => {
		const env: CoachProviderEnv = {
			appEnv: 'production',
			LLM_PROVIDER: 'mock',
			ANTHROPIC_API_KEY: KEY
		};
		expect(resolve(env, true).choice).toEqual(unavailable('mock_in_production'));
	});

	it("'off' anywhere → disabled, with no warning", () => {
		for (const appEnv of APP_ENVS) {
			for (const launched of [true, false]) {
				const { choice, warn } = resolve(
					{ appEnv, LLM_PROVIDER: 'off', ANTHROPIC_API_KEY: KEY },
					launched
				);
				expect(choice).toEqual(unavailable('disabled'));
				expect(warn).not.toHaveBeenCalled();
			}
		}
	});

	it('development, test and preview use the badged mock unless anthropic is asked for', () => {
		for (const appEnv of ['development', 'test', 'preview'] as const) {
			expect(resolve({ appEnv, ANTHROPIC_API_KEY: KEY }, false).choice).toEqual(mock);
			expect(resolve({ appEnv, LLM_PROVIDER: 'mock' }, true).choice).toEqual(mock);
			expect(
				resolve({ appEnv, LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY }, false).choice
			).toEqual(anthropic);
		}
	});

	it('a misconfiguration logs one warning naming the variable, never the key', () => {
		const noKey = resolve({ appEnv: 'development', LLM_PROVIDER: 'anthropic' }, false);
		expect(noKey.choice).toEqual(unavailable('no_key'));
		expect(noKey.warn).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
			reason: 'no_key',
			appEnv: 'development',
			variable: 'ANTHROPIC_API_KEY'
		});

		const mocked = resolve(
			{ appEnv: 'production', LLM_PROVIDER: 'mock', ANTHROPIC_API_KEY: KEY },
			true
		);
		expect(mocked.warn).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
			reason: 'mock_in_production',
			appEnv: 'production',
			variable: 'LLM_PROVIDER'
		});
		expect(JSON.stringify(mocked.warn.mock.calls)).not.toContain(KEY);
	});

	it('only no_key and mock_in_production are misconfigurations, and only they keep direct answers', () => {
		const misconfigured = COACH_UNAVAILABLE_REASONS.filter(isMisconfiguration);
		expect(misconfigured).toEqual(['no_key', 'mock_in_production']);
		// not_launched and the 'off' kill switch refuse every turn, lookups included.
		expect([...DIRECT_ANSWER_REASONS].sort()).toEqual([...misconfigured].sort());
	});

	it('reads the parsed environment: a production server with no LLM_PROVIDER is not mocked', () => {
		const env = parseEnv({
			DATABASE_URL: 'postgres://coach:coach@localhost:5432/coach_dev',
			NODE_ENV: 'production',
			ANTHROPIC_API_KEY: KEY
		});
		expect(resolve(env, true).choice).toEqual(anthropic);
		expect(resolve(env, false).choice).toEqual(unavailable('not_launched'));
	});
});
