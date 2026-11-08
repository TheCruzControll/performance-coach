import { describe, expect, it } from 'vitest';
import {
	COACH_ERROR_KINDS,
	COACH_ERROR_KIND_LABEL,
	COACH_UNAVAILABLE_REASONS,
	COACH_UNAVAILABLE_REASON_LABEL
} from '#lib/domain/coach/index.ts';
import { scanAdvice } from '#lib/domain/coach/safety.ts';
import { ICON_NAMES } from '../icons/names.ts';
import {
	COACH_NOTICES,
	MOCK_BADGE,
	SCREEN_FAILURE_LABEL,
	type CoachNoticeKind
} from './coach-notices.ts';

const kinds = Object.keys(COACH_NOTICES) as CoachNoticeKind[];

describe('COACH_NOTICES', () => {
	it('words every reason the coach cannot run and every error a turn can end with', () => {
		for (const kind of [...COACH_UNAVAILABLE_REASONS, ...COACH_ERROR_KINDS]) {
			expect(COACH_NOTICES[kind], kind).toBeDefined();
		}
		expect(kinds).toHaveLength(
			COACH_UNAVAILABLE_REASONS.length +
				COACH_ERROR_KINDS.length +
				Object.keys(SCREEN_FAILURE_LABEL).length +
				1
		);
	});

	it('titles each state with the vocabulary’s own label, so no state is worded twice', () => {
		for (const reason of COACH_UNAVAILABLE_REASONS) {
			expect(COACH_NOTICES[reason].title).toBe(COACH_UNAVAILABLE_REASON_LABEL[reason]);
		}
		for (const kind of COACH_ERROR_KINDS) {
			expect(COACH_NOTICES[kind].title).toBe(COACH_ERROR_KIND_LABEL[kind]);
		}
		expect(COACH_NOTICES.not_launched.title).toBe('Your coach is getting ready');
		expect(COACH_NOTICES.disabled.title).toBe('The coach is switched off');
		expect(COACH_NOTICES.empty.title).toBe('No conversations yet');
	});

	it('offers Retry exactly where trying again can work', () => {
		const retried = kinds.filter((kind) => COACH_NOTICES[kind].retry).sort();
		expect(retried).toEqual(
			[
				'unavailable',
				'busy',
				'timeout',
				'provider',
				'cancelled',
				'interrupted',
				'invalid_request',
				'offline',
				'chunk_failed',
				'load_failed',
				'action_failed'
			].sort()
		);
		// Waiting, a switch, a key or a different question fixes these, never the same request.
		for (const kind of [
			'not_launched',
			'disabled',
			'no_key',
			'rate_limited',
			'budget',
			'refused',
			'empty'
		] as const) {
			expect(COACH_NOTICES[kind].retry, kind).toBe(false);
		}
	});

	it('says what to do next in a sentence, with an icon from the sprite', () => {
		for (const kind of kinds) {
			const { title, body, icon } = COACH_NOTICES[kind];
			expect(title.length, kind).toBeGreaterThan(0);
			expect(body, kind).toMatch(/^[A-Z].*\.$/);
			expect(body, kind).not.toBe(title);
			expect(ICON_NAMES, kind).toContain(icon);
		}
		const titles = kinds.map((kind) => COACH_NOTICES[kind].title);
		expect(new Set(titles).size).toBe(titles.length);
	});

	it('announces only the failures that need acting on at once', () => {
		const alerts = kinds.filter((kind) => COACH_NOTICES[kind].tone === 'danger').sort();
		expect(alerts).toEqual(
			['provider', 'invalid_request', 'chunk_failed', 'load_failed', 'action_failed'].sort()
		);
	});

	it('names no provider or model and passes the coach’s own advice scan', () => {
		const words = [
			...kinds.flatMap((kind) => [COACH_NOTICES[kind].title, COACH_NOTICES[kind].body]),
			MOCK_BADGE.label,
			MOCK_BADGE.description
		];
		for (const text of words) {
			expect(text).not.toMatch(/anthropic|claude|openai|gpt|llm|\bmodel\b|\bAI\b/i);
			expect(scanAdvice(text, { painContext: true }), text).toEqual([]);
		}
	});
});
