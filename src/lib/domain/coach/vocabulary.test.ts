import { describe, expect, it } from 'vitest';
import * as training from '../training/vocabulary';
import * as vocabulary from './vocabulary';
import {
	ANSWER_BLOCK_KIND_LABEL,
	ANSWER_BLOCK_KINDS,
	COACH_ERROR_KIND_LABEL,
	COACH_ERROR_KINDS,
	COACH_UNAVAILABLE_REASON_LABEL,
	COACH_UNAVAILABLE_REASONS,
	MESSAGE_KIND_LABEL,
	MESSAGE_KINDS,
	MESSAGE_ROLE_LABEL,
	MESSAGE_ROLES,
	MESSAGE_STATUS_LABEL,
	MESSAGE_STATUSES,
	RUN_STATUS_LABEL,
	RUN_STATUSES,
	SUPERSEDED_REASON_LABEL,
	SUPERSEDED_REASONS,
	THREAD_TITLE_SOURCE_LABEL,
	THREAD_TITLE_SOURCES,
	TOOL_CALL_STATUS_LABEL,
	TOOL_CALL_STATUSES
} from './vocabulary';

/** Every list with its label table. A new list must be added here (the first test fails if not). */
const LISTS: Record<string, [readonly string[], Readonly<Record<string, string>>]> = {
	ANSWER_BLOCK_KINDS: [ANSWER_BLOCK_KINDS, ANSWER_BLOCK_KIND_LABEL],
	THREAD_TITLE_SOURCES: [THREAD_TITLE_SOURCES, THREAD_TITLE_SOURCE_LABEL],
	MESSAGE_ROLES: [MESSAGE_ROLES, MESSAGE_ROLE_LABEL],
	MESSAGE_KINDS: [MESSAGE_KINDS, MESSAGE_KIND_LABEL],
	MESSAGE_STATUSES: [MESSAGE_STATUSES, MESSAGE_STATUS_LABEL],
	RUN_STATUSES: [RUN_STATUSES, RUN_STATUS_LABEL],
	TOOL_CALL_STATUSES: [TOOL_CALL_STATUSES, TOOL_CALL_STATUS_LABEL],
	SUPERSEDED_REASONS: [SUPERSEDED_REASONS, SUPERSEDED_REASON_LABEL],
	COACH_UNAVAILABLE_REASONS: [COACH_UNAVAILABLE_REASONS, COACH_UNAVAILABLE_REASON_LABEL],
	COACH_ERROR_KINDS: [COACH_ERROR_KINDS, COACH_ERROR_KIND_LABEL]
};

describe('coach vocabulary', () => {
	it('tests every list and every label table it exports', () => {
		const lists = Object.entries(vocabulary).filter(([, value]) => Array.isArray(value));
		expect(lists.map(([name]) => name).sort()).toEqual(Object.keys(LISTS).sort());
		const tested = new Set(Object.values(LISTS).map(([, labels]) => labels));
		for (const [name, value] of Object.entries(vocabulary)) {
			if (name.endsWith('_LABEL')) expect(tested.has(value as never), name).toBe(true);
		}
	});

	it('has unique snake_case keys, each with a label', () => {
		for (const [name, [keys, labels]] of Object.entries(LISTS)) {
			expect(keys.length, name).toBeGreaterThan(0);
			expect(new Set(keys).size, name).toBe(keys.length);
			expect(Object.keys(labels), name).toEqual([...keys]);
			for (const key of keys) {
				expect(key, name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
				expect(labels[key]?.trim(), `${name}.${key}`).toBeTruthy();
			}
		}
	});

	it('keeps the planned keys that later slices store, CHECK and branch on', () => {
		expect(ANSWER_BLOCK_KINDS).toEqual(['fact', 'metric', 'recommendation', 'safety', 'note']);
		expect(THREAD_TITLE_SOURCES).toEqual(['first_message', 'owner']);
		expect(MESSAGE_ROLES).toEqual(['user', 'assistant', 'system']);
		expect(MESSAGE_KINDS).toEqual([
			'owner_message',
			'segment_preamble',
			'context',
			'assistant',
			'tool_results',
			'display_only'
		]);
		expect(COACH_UNAVAILABLE_REASONS).toEqual([
			'no_key',
			'mock_in_production',
			'not_launched',
			'disabled'
		]);
		expect(SUPERSEDED_REASONS).toEqual([
			'program_changed',
			'revised',
			'review_refreshed',
			'folded_into_review',
			'sessions_passed',
			'cycle_planned'
		]);
		expect(RUN_STATUSES[0]).toBe('running');
	});

	it('never redefines a training list name', () => {
		const names = new Set(Object.keys(training));
		for (const name of Object.keys(vocabulary)) expect(names.has(name), name).toBe(false);
	});
});
