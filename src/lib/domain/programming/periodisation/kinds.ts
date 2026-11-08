/**
 * M7's block types as week kinds (m7-contract): the phases each block type is planned in, the
 * week kind of every week it holds, which week kinds are light, and the reason Train and Today
 * give for a light or special week that has no decision of its own (an M3-built program, say).
 * Every block-type and week-line slice reads this file; none edits it.
 */
import type { Phase, WeekKind } from '../../training/vocabulary.ts';

/** The block types M7 plans. */
export type BlockType =
	'strength' | 'hypertrophy' | 'marathon' | 'half' | 'fight_camp' | 'recovery' | 'maintenance';

/** The phases a block type is planned in, in order. */
export const BLOCK_PHASES = {
	strength: ['accumulation', 'intensification', 'realization', 'taper'],
	hypertrophy: ['hypertrophy'],
	marathon: ['marathon_base', 'marathon_build', 'marathon_peak', 'marathon_taper'],
	half: ['half_base', 'half_build', 'half_peak', 'half_taper'],
	fight_camp: ['fight_camp'],
	recovery: ['recovery'],
	maintenance: ['maintenance']
} as const satisfies Record<BlockType, readonly Phase[]>;

/** The week kind of each week a block type holds, by the week's role in the block. */
export const BLOCK_WEEK_KINDS = {
	strength: {
		accumulation: 'accumulation',
		intensification: 'intensification',
		realization: 'peak',
		meet_taper: 'taper',
		meet: 'event',
		deload: 'deload'
	},
	hypertrophy: { building: 'accumulation', deload: 'deload' },
	marathon: {
		base: 'base',
		build: 'build',
		peak: 'peak',
		cutback: 'cutback',
		taper: 'taper',
		race: 'event',
		deload: 'deload'
	},
	half: {
		base: 'base',
		build: 'build',
		peak: 'peak',
		cutback: 'cutback',
		taper: 'taper',
		race: 'event',
		deload: 'deload'
	},
	fight_camp: { camp: 'build', sparring_peak: 'peak', fight: 'event', deload: 'deload' },
	recovery: { recovery: 'recovery' },
	maintenance: { maintenance: 'maintenance', deload: 'deload' }
} as const satisfies Record<BlockType, Readonly<Record<string, WeekKind>>>;

/** Weeks planned lighter for every stream. */
export const LIGHT_WEEK_KINDS = [
	'deload',
	'taper',
	'event',
	'recovery'
] as const satisfies readonly WeekKind[];

/** A cutback is light for running only: strength and Muay Thai train through it. */
export const LIGHT_RUNNING_WEEK_KINDS = [
	...LIGHT_WEEK_KINDS,
	'cutback'
] as const satisfies readonly WeekKind[];

/**
 * The reason a week line gives for its week's kind when the week has no decision of its own.
 * Each is one complete sentence of at most 80 characters.
 */
export const WEEK_KIND_WHY = {
	deload: 'Lighter on purpose, so the block’s work sinks in.',
	taper: 'Lighter so you arrive fresh.',
	event: 'Race week: rest and sharpen.',
	recovery: 'Easy days to recover from your event.',
	cutback: 'A lighter running week, so the build stays sustainable.',
	maintenance: 'Every goal held at its maintenance dose.'
} as const satisfies Partial<Record<WeekKind, string>>;
