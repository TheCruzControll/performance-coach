/**
 * The rules registry (m7-contract): every area's entries in one list, each superseded rule
 * marked with the rule replacing it. Never edited again: an area file adds its own entries and,
 * optionally, a `supersedes` map. rules-reference renders it as docs/programming-rules.md.
 */
import * as concurrent from './concurrent.ts';
import * as deload from './deload.ts';
import * as endurance from './endurance.ts';
import * as evaluation from './evaluation.ts';
import * as fatigue from './fatigue.ts';
import * as fightCamp from './fight-camp.ts';
import * as generator from './generator.ts';
import * as hypertrophy from './hypertrophy.ts';
import * as interference from './interference.ts';
import * as load from './load.ts';
import * as m3 from './m3.ts';
import * as m4 from './m4.ts';
import * as m6 from './m6.ts';
import * as maintenance from './maintenance.ts';
import * as paces from './paces.ts';
import * as priority from './priority.ts';
import * as replan from './replan.ts';
import * as road from './road.ts';
import * as schedule from './schedule.ts';
import * as season from './season.ts';
import * as strengthPhases from './strength-phases.ts';
import * as targets from './targets.ts';
import * as taper from './taper.ts';
import type { RuleArea, RuleAreaModule, RuleEntry } from './types.ts';

/** Every area's file, in RULE_AREAS order. */
export const AREAS: Readonly<Record<RuleArea, RuleAreaModule>> = {
	interference,
	evaluation,
	load,
	fatigue,
	concurrent,
	schedule,
	priority,
	maintenance,
	season,
	road,
	'strength-phases': strengthPhases,
	hypertrophy,
	endurance,
	'fight-camp': fightCamp,
	deload,
	taper,
	paces,
	generator,
	replan,
	targets,
	m3,
	m4,
	m6
};

/**
 * The areas' entries, in area order, with their status. Throws on an id used twice, or on a
 * supersedes map that names an id no area defines.
 */
export function buildRegistry(areas: Readonly<Partial<Record<RuleArea, RuleAreaModule>>>) {
	const entries = new Map<string, RuleEntry>();
	for (const [area, { rules }] of Object.entries(areas) as [RuleArea, RuleAreaModule][]) {
		for (const rule of rules) {
			if (entries.has(rule.id)) throw new Error(`The rule '${rule.id}' is registered twice`);
			entries.set(rule.id, { ...rule, area, status: 'active' });
		}
	}
	for (const { supersedes = {} } of Object.values(areas)) {
		for (const [old, by] of Object.entries(supersedes)) {
			const entry = entries.get(old);
			if (!entry || !entries.has(by)) {
				throw new Error(`'${old}' superseded by '${by}': both must be registered`);
			}
			entries.set(old, { ...entry, status: 'superseded', supersededBy: by });
		}
	}
	return [...entries.values()];
}

/** Every registered rule. */
export const RULES: readonly RuleEntry[] = buildRegistry(AREAS);

/** A rule by the key decisions cite. */
export const RULE_BY_ID: ReadonlyMap<string, RuleEntry> = new Map(RULES.map((r) => [r.id, r]));
