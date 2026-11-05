/**
 * Training-load metrics that work across disciplines (strength, running, Muay Thai, ...).
 */

export interface StrengthSet {
	weight: number;
	reps: number;
}

/** Volume load (tonnage): Σ weight × reps. */
export function volumeLoad(sets: readonly StrengthSet[]): number {
	return sets.reduce((sum, s) => sum + Math.max(0, s.weight) * Math.max(0, s.reps), 0);
}

/**
 * Session RPE load (Foster): session duration in minutes × session RPE (0–10), in arbitrary
 * units (AU). Comparable across disciplines, which is why the coach uses it for total load.
 */
export function sessionLoad(durationMinutes: number, sessionRpe: number): number {
	if (durationMinutes < 0) throw new RangeError('duration must be ≥ 0');
	if (sessionRpe < 0 || sessionRpe > 10) throw new RangeError('session RPE must be 0–10');
	return durationMinutes * sessionRpe;
}

/**
 * Acute:chronic workload ratio with exponentially weighted moving averages (Williams et al.
 * 2017): acute window 7 days, chronic 28 days. `dailyLoads` is oldest → newest, one entry per
 * day (0 for rest days). Returns null until there are at least `chronicDays` days of history.
 */
export function acuteChronicRatio(
	dailyLoads: readonly number[],
	acuteDays = 7,
	chronicDays = 28
): { acute: number; chronic: number; ratio: number | null } | null {
	if (dailyLoads.length < chronicDays) return null;
	const la = 2 / (acuteDays + 1);
	const lc = 2 / (chronicDays + 1);
	let acute = dailyLoads[0] ?? 0;
	let chronic = dailyLoads[0] ?? 0;
	for (const load of dailyLoads.slice(1)) {
		acute = load * la + (1 - la) * acute;
		chronic = load * lc + (1 - lc) * chronic;
	}
	return { acute, chronic, ratio: chronic > 0 ? acute / chronic : null };
}
