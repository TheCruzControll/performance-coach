/**
 * The program lifecycle: a program is stored `active` (one per owner, programs_one_active_uq) and
 * the owner can end it, which archives it. An archived program is history: its versions, the
 * workouts logged against it and its decisions stay, and Today offers Build my program again.
 * The history guard (drizzle program_history_guards) lets a program head change its status and
 * archived_at; nothing moves an archived program back. docs/lifecycles.md is generated from it.
 */
import { defineLifecycle } from '../lifecycle.ts';

export const PROGRAM_STATES = ['active', 'archived'] as const;
export type ProgramState = (typeof PROGRAM_STATES)[number];
export type ProgramEvent = 'end';

export const PROGRAM = /* @__PURE__ */ defineLifecycle<ProgramState, ProgramEvent>({
	id: 'program',
	storedIn: 'programs.status and archived_at (Postgres)',
	writeSites: ['src/lib/server/services/programs/archive.ts archiveProgram'],
	tests: ['tests/integration/programs/archive.test.ts', 'src/lib/domain/lifecycles.test.ts'],
	states: PROGRAM_STATES,
	initial: ['active'],
	terminal: ['archived'],
	on: {
		end: {
			from: ['active'],
			to: 'archived',
			effects: [
				'programs: status, archived_at',
				'its open coach proposals are superseded (program_changed)',
				'Today offers Build my program again; logged workouts and History are kept'
			],
			why: 'Refused while a workout of the program is in progress (workout_in_progress).'
		}
	}
});
