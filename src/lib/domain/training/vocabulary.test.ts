import { describe, expect, it } from 'vitest';
import * as m2 from '../profile/catalog';
import {
	BASELINE_KINDS,
	DISCIPLINE_INFO,
	DISCIPLINES,
	EQUIPMENT,
	EXPERIENCE_LEVELS,
	INTENSITIES,
	TIMES_OF_DAY,
	WEEKDAYS
} from '../profile/catalog';
import * as vocabulary from './vocabulary';
import {
	DECIDER_LABEL,
	DECIDERS,
	DECISION_KIND_LABEL,
	DECISION_KINDS,
	EXERCISE_TAG_LABEL,
	EXERCISE_TAGS,
	fromCommitmentIntensity,
	LOAD_BASES,
	LOAD_BASIS_LABEL,
	LOAD_KIND_LABEL,
	LOAD_KINDS,
	LOAD_TYPE_LABEL,
	LOAD_TYPES,
	MEASURE_LABEL,
	MEASURES,
	MOVEMENT_PATTERN_LABEL,
	MOVEMENT_PATTERNS,
	MUSCLE_GROUP,
	MUSCLE_GROUP_LABEL,
	MUSCLE_GROUPS,
	MUSCLE_LABEL,
	MUSCLES,
	OTHER_SESSION_KIND_LABEL,
	OTHER_SESSION_KINDS,
	PHASE_LABEL,
	PHASES,
	PLAN_STATUS_LABEL,
	PLAN_STATUSES,
	PREFERENCE_SOURCE_LABEL,
	PREFERENCE_SOURCES,
	PROPOSAL_STATUS_LABEL,
	PROPOSAL_STATUSES,
	RUN_SEGMENT_KIND_LABEL,
	RUN_SEGMENT_KINDS,
	SESSION_INTENSITIES,
	SESSION_INTENSITY_LABEL,
	SESSION_STATUS_LABEL,
	SESSION_STATUSES,
	SESSION_TYPE_LABEL,
	SESSION_TYPES,
	sessionTone,
	SET_ROLE_LABEL,
	SET_ROLES,
	SKILL_LEVEL_LABEL,
	SKILL_LEVELS,
	skillForExperience,
	SUBSTITUTION_REASON_LABEL,
	SUBSTITUTION_REASONS,
	WEEK_KIND_LABEL,
	WEEK_KINDS
} from './vocabulary';

/** Every list with its label table. A new list must be added here (the next test fails if not). */
const LISTS: Record<string, [readonly string[], Readonly<Record<string, string>>]> = {
	MOVEMENT_PATTERNS: [MOVEMENT_PATTERNS, MOVEMENT_PATTERN_LABEL],
	MUSCLE_GROUPS: [MUSCLE_GROUPS, MUSCLE_GROUP_LABEL],
	MUSCLES: [MUSCLES, MUSCLE_LABEL],
	EXERCISE_TAGS: [EXERCISE_TAGS, EXERCISE_TAG_LABEL],
	SKILL_LEVELS: [SKILL_LEVELS, SKILL_LEVEL_LABEL],
	MEASURES: [MEASURES, MEASURE_LABEL],
	LOAD_TYPES: [LOAD_TYPES, LOAD_TYPE_LABEL],
	PHASES: [PHASES, PHASE_LABEL],
	WEEK_KINDS: [WEEK_KINDS, WEEK_KIND_LABEL],
	SESSION_TYPES: [SESSION_TYPES, SESSION_TYPE_LABEL],
	OTHER_SESSION_KINDS: [OTHER_SESSION_KINDS, OTHER_SESSION_KIND_LABEL],
	SET_ROLES: [SET_ROLES, SET_ROLE_LABEL],
	RUN_SEGMENT_KINDS: [RUN_SEGMENT_KINDS, RUN_SEGMENT_KIND_LABEL],
	PLAN_STATUSES: [PLAN_STATUSES, PLAN_STATUS_LABEL],
	SESSION_STATUSES: [SESSION_STATUSES, SESSION_STATUS_LABEL],
	SESSION_INTENSITIES: [SESSION_INTENSITIES, SESSION_INTENSITY_LABEL],
	LOAD_KINDS: [LOAD_KINDS, LOAD_KIND_LABEL],
	LOAD_BASES: [LOAD_BASES, LOAD_BASIS_LABEL],
	DECIDERS: [DECIDERS, DECIDER_LABEL],
	DECISION_KINDS: [DECISION_KINDS, DECISION_KIND_LABEL],
	SUBSTITUTION_REASONS: [SUBSTITUTION_REASONS, SUBSTITUTION_REASON_LABEL],
	PREFERENCE_SOURCES: [PREFERENCE_SOURCES, PREFERENCE_SOURCE_LABEL],
	PROPOSAL_STATUSES: [PROPOSAL_STATUSES, PROPOSAL_STATUS_LABEL]
};

describe('training vocabulary', () => {
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

	it('puts every muscle in exactly one known group, and leaves no group empty', () => {
		expect(Object.keys(MUSCLE_GROUP).sort()).toEqual([...MUSCLES].sort());
		for (const muscle of MUSCLES) expect(MUSCLE_GROUPS).toContain(MUSCLE_GROUP[muscle]);
		for (const group of MUSCLE_GROUPS) {
			expect(Object.values(MUSCLE_GROUP), group).toContain(group);
		}
	});

	it('maps every M2 experience level to a skill level, never lower for more experience', () => {
		const ranks = EXPERIENCE_LEVELS.map((level) => SKILL_LEVELS.indexOf(skillForExperience(level)));
		expect(ranks.every((rank) => rank >= 0)).toBe(true);
		expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
		// A novice is still prescribed only beginner exercises.
		expect(EXPERIENCE_LEVELS.map(skillForExperience)).toEqual([
			'beginner',
			'beginner',
			'intermediate',
			'advanced'
		]);
	});

	it('maps every M2 commitment intensity to a session intensity, in order', () => {
		const ranks = INTENSITIES.map((i) => SESSION_INTENSITIES.indexOf(fromCommitmentIntensity(i)));
		expect(ranks.every((rank) => rank >= 0)).toBe(true);
		expect(new Set(ranks).size).toBe(INTENSITIES.length);
		expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
		expect(fromCommitmentIntensity('moderate')).toBe('moderate');
	});

	it("gives every session type one of M2's discipline tones", () => {
		const tones = new Set(Object.values(DISCIPLINE_INFO).map((info) => info.tone));
		for (const type of SESSION_TYPES) expect(tones.has(sessionTone(type)), type).toBe(true);
		const typesIn = (tone: string) => SESSION_TYPES.filter((type) => sessionTone(type) === tone);
		expect(typesIn(DISCIPLINE_INFO.strength.tone)).toEqual(['strength', 'power', 'strength_class']);
		expect(typesIn(DISCIPLINE_INFO.running.tone)).toEqual(
			SESSION_TYPES.filter((type) => type.endsWith('_run'))
		);
		expect(sessionTone('muay_thai')).toBe(DISCIPLINE_INFO.muay_thai.tone);
		expect(sessionTone('hypertrophy')).toBe(DISCIPLINE_INFO.hypertrophy.tone);
	});

	it('reuses the M2 catalogue instead of redefining it', () => {
		const m2Names = new Set(Object.keys(m2));
		for (const name of Object.keys(vocabulary)) expect(m2Names.has(name), name).toBe(false);

		const reused = {
			DISCIPLINES,
			EQUIPMENT,
			EXPERIENCE_LEVELS,
			WEEKDAYS,
			TIMES_OF_DAY,
			INTENSITIES
		};
		for (const [name, [keys]] of Object.entries(LISTS)) {
			for (const [m2Name, m2Keys] of Object.entries(reused)) {
				const copied = m2Keys.every((key) => (keys as readonly string[]).includes(key));
				expect(copied, `${name} copies ${m2Name}`).toBe(false);
			}
			// Equipment, weekdays and times of day only ever mean one thing.
			for (const key of [...EQUIPMENT, ...WEEKDAYS, ...TIMES_OF_DAY]) {
				expect(keys, name).not.toContain(key);
			}
		}
		// A load's basis is M2's baseline kind itself, so measured and estimated never drift apart.
		expect(LOAD_BASES).toBe(BASELINE_KINDS);
	});

	it('lists every M3 decision kind up front, each with a label', () => {
		const m3 = [
			'program_purpose',
			'block_structure',
			'event_taper',
			'default_assumed',
			'goal_excluded',
			'commitment_placed',
			'day_allocation',
			'split_chosen',
			'exercise_selected',
			'exercise_excluded',
			'exercise_substituted',
			'slot_empty',
			'time_trimmed',
			'load_basis',
			'progression',
			'volume_adjusted',
			'run_volume',
			'run_pace_source',
			'quality_session',
			'session_placed',
			'interference_resolved',
			'priority_tradeoff',
			'session_dropped',
			'unmapped_avoidance',
			'owner_confirmed',
			'session_moved',
			'session_skipped',
			'exercise_swapped',
			'prescription_adjusted',
			'preference_recorded'
		];
		expect(DECISION_KINDS).toEqual(expect.arrayContaining(m3));
		for (const kind of m3) expect(DECISION_KIND_LABEL[kind as never], kind).toBeTruthy();
	});

	it("adds M6's decision kinds, the 'Between blocks' phase and the unplanned week", () => {
		const m6 = [
			'review_applied',
			'results_progression',
			'fatigue_managed',
			'deload_scheduled',
			'next_block_planned',
			'exercise_kept',
			'exercise_rotated'
		];
		expect(DECISION_KINDS.slice(-m6.length)).toEqual(m6);
		expect(PHASE_LABEL.transition).toBe('Between blocks');
		expect(WEEK_KIND_LABEL.unplanned).toBe('Unplanned week');
	});

	it("includes M4's substitution reasons, each with a label", () => {
		const reasons = [
			'situational',
			'equipment_unavailable',
			'dislike',
			'pain',
			'injury',
			'coach_suggestion',
			'owner_choice'
		];
		expect(SUBSTITUTION_REASONS).toEqual(expect.arrayContaining(reasons));
		for (const r of reasons) expect(SUBSTITUTION_REASON_LABEL[r as never], r).toBeTruthy();
	});

	it("never stores 'completed': it is derived on top of the stored plan statuses", () => {
		expect(PLAN_STATUSES).toEqual(['planned', 'skipped', 'moved']);
		expect(SESSION_STATUSES).toEqual([...PLAN_STATUSES, 'completed']);
	});

	it('changes a closed list only together with the migration that CHECKs it', () => {
		expect(SKILL_LEVELS).toEqual(['beginner', 'intermediate', 'advanced']);
		expect(MEASURES).toEqual(['reps', 'time', 'distance']);
		expect(LOAD_TYPES).toEqual(['external', 'bodyweight', 'assisted', 'none']);
		expect(SESSION_INTENSITIES).toEqual(['easy', 'moderate', 'hard', 'very_hard']);
		expect(LOAD_KINDS).toEqual(['absolute', 'percent_1rm', 'rpe_based', 'from_e1rm']);
		expect(LOAD_BASES).toEqual(['measured', 'estimated']);
		expect(DECIDERS).toEqual(['owner', 'coach', 'rules']);
		expect(PREFERENCE_SOURCES).toEqual(['onboarding', 'profile', 'swap', 'workout', 'coach']);
		expect(PROPOSAL_STATUSES).toEqual(['proposed', 'accepted', 'rejected', 'applied']);
	});
});
