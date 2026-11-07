/**
 * What a backup holds (M9 plan, 'include by default, with a named deny-list'): every table of
 * the public schema except EXCLUDED_TABLES, so a table a later milestone adds is backed up with
 * no edit here. The catalog only has to keep three invariants, which exportPlan checks before a
 * single row is read:
 *
 * - every exported table has a primary key (rows are read, digested and restored in its order)
 * - planRestore finds a load order (a cycle of foreign keys needs a nullable key column)
 * - the keys planRestore makes late are exactly the reviewed LATE_ALLOWED columns
 *
 * Owner decision (M9 open question 'Backup contents'): auth tables and telemetry are included;
 * only sessions, challenges, rate-limit counters, single-use links and backup_runs are left out.
 * Changing that is one edit to EXCLUDED_TABLES.
 *
 * Server-only by use; imported by path with relative .ts specifiers, so scripts run it under
 * plain Node.
 */
import {
	planRestore,
	type Catalog,
	type CatalogTable,
	type RestorePlan
} from '../../../domain/backup/plan.ts';

/** Tables never exported, each with its reason. A name the catalog does not hold yet is reported. */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
	auth_sessions: 'Sign-in sessions: a restore signs every device out, and the owner signs in again',
	webauthn_challenges: 'Single-use passkey challenges that expire within minutes',
	auth_rate_limits: 'Rate-limit counters that reset on their own',
	email_sign_in_links: 'Single-use email sign-in links that expire within minutes',
	backup_runs: "The backups' own run log, which describes the database rather than being in it"
};

/**
 * The reviewed `table.column` list of keys restore may insert as NULL and fill in afterwards
 * (planRestore's late keys). A new cross-table cycle fails the export by name until it is added.
 */
export const LATE_ALLOWED: readonly string[] = ['programs.current_version_id'];

export type BackupExportErrorCode = 'already_running' | 'no_primary_key' | 'late_not_allowed';

/** An export that cannot run. Its message names tables and columns, never a row's value. */
export class BackupExportError extends Error {
	readonly code: BackupExportErrorCode;
	readonly names: string[];

	constructor(code: BackupExportErrorCode, message: string, names: string[] = []) {
		super(message);
		this.name = 'BackupExportError';
		this.code = code;
		this.names = names;
	}
}

export interface ExportPlan {
	/** The exported tables, in restore order. */
	tables: CatalogTable[];
	/** The excluded tables the catalog holds, in name order. */
	excluded: { name: string; reason: string }[];
	/** Excluded names the catalog does not hold (yet). */
	absentExcluded: string[];
	restore: RestorePlan;
}

export interface ExportPlanOptions {
	excluded?: Readonly<Record<string, string>>;
	lateAllowed?: readonly string[];
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The tables to export and their order, or a refusal: BackupExportError no_primary_key or
 * late_not_allowed, or planRestore's RestorePlanError, each naming its tables.
 */
export function exportPlan(
	catalog: Catalog,
	{ excluded = EXCLUDED_TABLES, lateAllowed = LATE_ALLOWED }: ExportPlanOptions = {}
): ExportPlan {
	const held = new Map(catalog.tables.map((t) => [t.name, t]));
	const leftOut = Object.keys(excluded).sort(byText);
	const exported = catalog.tables.filter((t) => !Object.hasOwn(excluded, t.name));

	const keyless = exported.filter((t) => t.primaryKey.length === 0).map((t) => t.name);
	if (keyless.length > 0) {
		throw new BackupExportError(
			'no_primary_key',
			`No primary key, so no row order to export: ${keyless.sort(byText).join(', ')}`,
			keyless
		);
	}

	const restore = planRestore(catalog, leftOut);
	const allowed = new Set(lateAllowed);
	const unreviewed = restore.late
		.flatMap((late) => late.columns.map((column) => `${late.table}.${column}`))
		.filter((name) => !allowed.has(name));
	if (unreviewed.length > 0) {
		throw new BackupExportError(
			'late_not_allowed',
			`A foreign-key cycle makes these columns late, and LATE_ALLOWED does not list them: ${unreviewed.join(', ')}`,
			unreviewed
		);
	}

	return {
		tables: restore.order.map((name) => held.get(name)!),
		excluded: leftOut
			.filter((name) => held.has(name))
			.map((name) => ({ name, reason: excluded[name]! })),
		absentExcluded: leftOut.filter((name) => !held.has(name)),
		restore
	};
}
