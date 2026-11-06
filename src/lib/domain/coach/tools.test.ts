import { describe, expect, it } from 'vitest';
import {
	isToolName,
	TOOL_CATALOGUE,
	TOOL_EFFECTS,
	TOOL_GROUPS,
	TOOL_NAMES,
	type ToolEffect,
	type ToolGroup,
	type ToolName
} from './tools';

/** The brief's five groups (PRD §4, M5 brief), plus the plan's three additions. */
const BY_GROUP: Record<ToolGroup, readonly ToolName[]> = {
	history: [
		'get_training_history',
		'get_exercise_history',
		'get_running_history',
		'get_recent_workouts',
		'get_personal_records'
	],
	programming: [
		'get_current_program',
		'get_current_training_week',
		'get_training_schedule',
		'get_program_history',
		'get_coach_proposals',
		'propose_program_adjustment',
		'create_training_program',
		'create_next_training_cycle'
	],
	workout: [
		'get_current_workout',
		'get_exercise_alternatives',
		'update_workout',
		'substitute_exercise',
		'save_workout_analysis'
	],
	preferences: ['get_training_preferences', 'update_exercise_preferences', 'update_training_goals'],
	analytics: ['get_weekly_training_summary', 'get_training_load', 'get_performance_trends']
};

/** Proposals: a coach_proposals row and nothing else. Writes: the brief's two direct writes. */
const PROPOSE: readonly ToolName[] = [
	'create_next_training_cycle',
	'create_training_program',
	'propose_program_adjustment',
	'substitute_exercise',
	'update_training_goals',
	'update_workout'
];
const WRITE: readonly ToolName[] = ['save_workout_analysis', 'update_exercise_preferences'];
const DRAFTS: readonly ToolName[] = [
	'create_next_training_cycle',
	'propose_program_adjustment',
	'update_workout'
];

const namesWhere = (keep: (name: ToolName) => boolean) => TOOL_NAMES.filter(keep);

describe('the coach tool catalogue', () => {
	it('names 24 tools once each, in snake_case, sorted by code unit', () => {
		expect(TOOL_NAMES).toHaveLength(24);
		expect(new Set(TOOL_NAMES).size).toBe(24);
		for (const name of TOOL_NAMES) expect(name).toMatch(/^[a-z]+(_[a-z]+)+$/);
		const sorted = [...TOOL_NAMES].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		expect(TOOL_NAMES).toEqual(sorted);
		expect([...TOOL_NAMES].sort()).toEqual(Object.keys(TOOL_CATALOGUE).sort());
	});

	it('puts each of the five groups’ tools, and only those, in that group', () => {
		expect(TOOL_GROUPS).toEqual(['history', 'programming', 'workout', 'preferences', 'analytics']);
		for (const group of TOOL_GROUPS) {
			expect(namesWhere((name) => TOOL_CATALOGUE[name].group === group)).toEqual(
				[...BY_GROUP[group]].sort()
			);
		}
	});

	it('reads with every tool except six that propose and the two direct writes', () => {
		const effectOf = (effect: ToolEffect) =>
			namesWhere((name) => TOOL_CATALOGUE[name].effect === effect);
		expect(TOOL_EFFECTS).toEqual(['read', 'propose', 'write']);
		expect(effectOf('propose')).toEqual(PROPOSE);
		expect(effectOf('write')).toEqual(WRITE);
		expect(effectOf('read')).toHaveLength(16);
		for (const name of effectOf('read')) expect(name).toMatch(/^get_/);
	});

	it('marks exactly update_workout, propose_program_adjustment and create_next_training_cycle as drafting', () => {
		expect(namesWhere((name) => TOOL_CATALOGUE[name].drafts === true)).toEqual(DRAFTS);
		for (const name of DRAFTS) expect(TOOL_CATALOGUE[name].effect).toBe('propose');
	});

	it('recognises a catalogue name, and nothing else, as a tool name', () => {
		for (const name of TOOL_NAMES) expect(isToolName(name)).toBe(true);
		for (const other of ['', 'get_everything', 'toString', '__proto__', 'GET_CURRENT_PROGRAM'])
			expect(isToolName(other)).toBe(false);
	});

	it('cannot be changed at run time', () => {
		expect(Object.isFrozen(TOOL_CATALOGUE)).toBe(true);
		expect(Object.isFrozen(TOOL_NAMES)).toBe(true);
		for (const name of TOOL_NAMES) expect(Object.isFrozen(TOOL_CATALOGUE[name])).toBe(true);
	});
});
