/**
 * Goals (PRD §2): several at once, each an event or a general goal, explicitly ranked. Rank 1
 * wins when goals compete for recovery or time — the coach (M5) reads the ranking, so it is
 * always contiguous (1..n over open goals) and every change is recorded in
 * `training_goal_events` with a snapshot of the goal.
 */
import { OPEN_GOAL_STATUSES, type GoalStatus } from '../../../domain/profile/catalog';
import {
	goalOrderSchema,
	goalSchema,
	goalStatusSchema,
	type GoalData
} from '../../../domain/profile/schemas';
import type { Goal } from '../../../domain/profile/types';
import {
	createProfileRepository,
	type GoalRow,
	type NewGoal,
	type ProfileRepository
} from '../../db';
import { measure } from '../../observability/timing';
import { isUuid } from '../ids';
import {
	parseWith,
	ProfileInputError,
	ProfileNotFoundError,
	resolveDeps,
	toGoal,
	type ChangeSource,
	type ProfileDeps
} from './shared';

const isOpen = (status: GoalStatus) => OPEN_GOAL_STATUSES.includes(status);

/** Columns for a validated goal; the other kind's fields are cleared. */
function goalColumns(goal: GoalData) {
	const common = {
		kind: goal.kind,
		title: goal.title,
		disciplines: goal.disciplines,
		customDiscipline: goal.disciplines.includes('custom') ? goal.customDiscipline : null,
		notes: goal.notes
	};
	return goal.kind === 'event'
		? {
				...common,
				eventType: goal.eventType,
				eventDate: goal.eventDate,
				weightClass: goal.weightClass,
				targetPerformance: goal.targetPerformance,
				requirements: goal.requirements,
				focus: null,
				measure: null,
				targetDate: null
			}
		: {
				...common,
				eventType: null,
				eventDate: null,
				weightClass: null,
				targetPerformance: null,
				requirements: null,
				focus: goal.focus,
				measure: goal.measure,
				targetDate: goal.targetDate
			};
}

function snapshot(row: GoalRow): Record<string, unknown> {
	const { ownerId: _owner, ...rest } = row;
	return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
}

function events(
	ownerId: string,
	source: ChangeSource,
	at: Date,
	change: 'created' | 'updated' | 'reprioritized' | 'status_changed' | 'deleted',
	rows: GoalRow[]
) {
	return rows.map((row) => ({
		ownerId,
		goalId: row.id,
		change,
		snapshot: snapshot(row),
		source,
		occurredAt: at
	}));
}

/** Re-rank open goals 1..n in their current order (after one leaves the ranking). */
async function compact(repo: ProfileRepository, ownerId: string, now: Date) {
	const open = (await repo.listGoals(ownerId)).filter((g) => g.priority !== null);
	const changed = open.filter((g, i) => g.priority !== i + 1);
	if (changed.length === 0) return [];
	await repo.setPriorities(
		ownerId,
		open.map((g) => g.id),
		now
	);
	const after = await repo.listGoals(ownerId);
	return after.filter((g) => changed.some((c) => c.id === g.id));
}

/** Open goals by rank, then achieved/dropped goals. */
export async function listGoals(ownerId: string, deps: ProfileDeps = {}): Promise<Goal[]> {
	const { db } = resolveDeps(deps);
	const rows = await measure('db', () => createProfileRepository(db).listGoals(ownerId));
	return rows.map(toGoal);
}

export async function createGoal(
	ownerId: string,
	input: unknown,
	deps: ProfileDeps = {}
): Promise<Goal> {
	const goal = parseWith(goalSchema, input);
	const { db, now, source } = resolveDeps(deps);
	const status = goal.status ?? 'active';
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProfileRepository(tx);
			await repo.lockGoals(ownerId);
			const at = now();
			const open = (await repo.listGoals(ownerId)).filter((g) => g.priority !== null);
			const values: NewGoal = {
				ownerId,
				...goalColumns(goal),
				status,
				priority: isOpen(status) ? open.length + 1 : null,
				closedAt: isOpen(status) ? null : at,
				createdAt: at,
				updatedAt: at
			};
			const row = await repo.insertGoal(values);
			await repo.insertGoalEvents(events(ownerId, source, at, 'created', [row]));
			return toGoal(row);
		})
	);
}

/**
 * Change one goal under the goal lock, starting from the row as it is once the lock is held.
 * `columns` are the goal's own fields (none for a status change: what is stored stays); a status
 * change also moves the goal into or out of the ranking.
 */
async function changeGoal(
	ownerId: string,
	id: string,
	patch: { columns?: ReturnType<typeof goalColumns>; status?: GoalStatus },
	deps: ProfileDeps
): Promise<Goal> {
	const { db, now, source } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProfileRepository(tx);
			await repo.lockGoals(ownerId);
			const existing = isUuid(id) ? await repo.getGoal(ownerId, id) : null;
			if (!existing) throw new ProfileNotFoundError('goal');
			const at = now();
			const status = patch.status ?? existing.status;
			const reopened = isOpen(status) && !isOpen(existing.status);
			const closed = !isOpen(status) && isOpen(existing.status);
			let priority = existing.priority;
			if (reopened) {
				priority = (await repo.listGoals(ownerId)).filter((g) => g.priority !== null).length + 1;
			} else if (closed) {
				priority = null;
			}
			const row = await repo.updateGoal(ownerId, id, {
				...patch.columns,
				status,
				priority,
				closedAt: isOpen(status) ? null : (existing.closedAt ?? at),
				updatedAt: at
			});
			const change = status !== existing.status ? 'status_changed' : 'updated';
			const log = events(ownerId, source, at, change, [row!]);
			if (closed)
				log.push(...events(ownerId, source, at, 'reprioritized', await compact(repo, ownerId, at)));
			await repo.insertGoalEvents(log);
			return toGoal((await repo.getGoal(ownerId, id))!);
		})
	);
}

export async function updateGoal(
	ownerId: string,
	id: string,
	input: unknown,
	deps: ProfileDeps = {}
): Promise<Goal> {
	const goal = parseWith(goalSchema, input);
	return changeGoal(ownerId, id, { columns: goalColumns(goal), status: goal.status }, deps);
}

/**
 * Change only a goal's status (achieved, paused, dropped, active again). Nothing else is written,
 * so an edit committed while this waited for the lock (a second tab, the coach) is kept.
 */
export async function setGoalStatus(
	ownerId: string,
	id: string,
	input: unknown,
	deps: ProfileDeps = {}
): Promise<Goal> {
	const { status } = parseWith(goalStatusSchema, input);
	return changeGoal(ownerId, id, { status }, deps);
}

export async function deleteGoal(ownerId: string, id: string, deps: ProfileDeps = {}) {
	const { db, now, source } = resolveDeps(deps);
	await measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProfileRepository(tx);
			await repo.lockGoals(ownerId);
			const row = isUuid(id) ? await repo.deleteGoal(ownerId, id) : null;
			if (!row) throw new ProfileNotFoundError('goal');
			const at = now();
			await repo.insertGoalEvents([
				...events(ownerId, source, at, 'deleted', [row]),
				...events(ownerId, source, at, 'reprioritized', await compact(repo, ownerId, at))
			]);
		})
	);
}

/**
 * Set the ranking of open goals: `ids` is every open goal, top priority first. Anything else
 * (a missing, unknown or closed goal) is refused, so the ranking can never have gaps or ties.
 */
export async function reorderGoals(
	ownerId: string,
	input: unknown,
	deps: ProfileDeps = {}
): Promise<Goal[]> {
	const { ids } = parseWith(goalOrderSchema, input);
	const { db, now, source } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProfileRepository(tx);
			await repo.lockGoals(ownerId);
			const before = await repo.listGoals(ownerId);
			const open = before.filter((g) => g.priority !== null);
			const openIds = new Set(open.map((g) => g.id));
			if (ids.length !== open.length || !ids.every((id) => openIds.has(id))) {
				throw new ProfileInputError({ ids: 'Rank every open goal exactly once' });
			}
			const at = now();
			await repo.setPriorities(ownerId, ids, at);
			const after = await repo.listGoals(ownerId);
			const moved = after.filter(
				(g) => g.priority !== null && before.find((b) => b.id === g.id)?.priority !== g.priority
			);
			await repo.insertGoalEvents(events(ownerId, source, at, 'reprioritized', moved));
			return after.map(toGoal);
		})
	);
}

/** Goal history, newest first (what changed, when, and who changed it). */
export async function goalHistory(ownerId: string, deps: ProfileDeps = {}) {
	const { db } = resolveDeps(deps);
	return createProfileRepository(db).listGoalEvents(ownerId);
}
