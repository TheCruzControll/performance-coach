/**
 * The numbers an added session (../added.ts) is built by, beyond the generator's own: the RPE
 * each intent is held to, the conditioning session's length and effort, and which run and Muay
 * Thai format each intent names. Each number lives here and nowhere else. The default intent
 * lives beside ADD_INTENTS (training/edits.ts), where the coach's diff reads it too; it is
 * re-exported here for the builder and the Train week view.
 */
import type { AddIntent } from '../../training/edits.ts';
import type { OtherSessionKind, SessionType } from '../../training/vocabulary.ts';

export { DEFAULT_INTENT } from '../../training/edits.ts';

/** A strength or hypertrophy session's RPE by its intent, before the week's cap. */
export const STRENGTH_RPE: Readonly<Record<AddIntent, number>> = {
	easy: 6,
	moderate: 7,
	hard: 8
};

/** A conditioning session: its title, its length unless the owner gives one, and its RPE. */
export const CONDITIONING = {
	title: 'Conditioning',
	minutes: 30,
	rpe: { easy: 5, moderate: 6.5, hard: 8 }
} as const satisfies { title: string; minutes: number; rpe: Record<AddIntent, number> };

/** The run an intent names: easy running, a tempo run or intervals. */
export const RUN_TYPE = {
	easy: 'easy_run',
	moderate: 'tempo_run',
	hard: 'interval_run'
} as const satisfies Record<AddIntent, SessionType>;

/**
 * The Muay Thai format an intent names. A hard session is sparring, or pad work when the owner
 * does no sparring (added.ts).
 */
export const MUAY_THAI_KIND = {
	easy: 'technical',
	moderate: 'pad_work',
	hard: 'sparring'
} as const satisfies Record<
	AddIntent,
	Extract<OtherSessionKind, 'technical' | 'pad_work' | 'sparring'>
>;
