/**
 * Every script the mock coach plays, one file per group. Each later slice replaces only its own
 * group's file, so no two slices edit this one. The first script that matches the owner's message
 * plays, so general.ts, whose last script matches anything, comes last.
 */
import type { MockScript } from '../mock.ts';
import { analyticsScripts } from './analytics.ts';
import { generalScripts } from './general.ts';
import { historyScripts } from './history.ts';
import { preferenceScripts } from './preferences.ts';
import { programmingProposalScripts } from './programming-proposals.ts';
import { programmingReadScripts } from './programming-reads.ts';
import { safetyScripts } from './safety.ts';
import { testScripts } from './test.ts';
import { workoutScripts } from './workout.ts';

export const MOCK_SCRIPTS: readonly MockScript[] = Object.freeze([
	...historyScripts,
	...programmingReadScripts,
	...programmingProposalScripts,
	...workoutScripts,
	...preferenceScripts,
	...analyticsScripts,
	...safetyScripts,
	...testScripts,
	...generalScripts
]);
