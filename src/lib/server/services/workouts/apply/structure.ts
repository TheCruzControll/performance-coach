/**
 * Exercise skips, substitutions and dislikes (substitution-handlers replaces this stub): answered
 * rejected 'unsupported' until then. The client never sends them before their screens exist.
 */
import { unsupported } from './handler';

export const structureHandlers = unsupported([
	'exercise.skip',
	'exercise.substitute',
	'exercise.dislike'
] as const);
