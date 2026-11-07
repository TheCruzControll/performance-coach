/**
 * decisions.ts and its templates: every decision kind has words in exactly one area file, every
 * rendered decision is complete (no placeholder left, within the plan contract's limits), and
 * the log keeps a stable order and retargets refs when sessions move. The 'not told yet' defaults
 * are rendered from a real input.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import type { Goal, TrainingProfile } from '../profile/types';
import { decisionPlanSchema } from '../training/schemas';
import { DECISION_KINDS } from '../training/vocabulary';
import { validate } from '../validation';
import { DecisionLog, render, TEMPLATES } from './decisions';
import { blocks } from './decisions/templates/blocks';
import { defaults } from './decisions/templates/defaults';
import { edits, NO_REASON } from './decisions/templates/edits';
import { loads } from './decisions/templates/loads';
import { placement } from './decisions/templates/placement';
import { program } from './decisions/templates/program';
import { results } from './decisions/templates/results';
import { running } from './decisions/templates/running';
import { strength } from './decisions/templates/strength';
import { volume } from './decisions/templates/volume';
import { buildProgrammingInput } from './input';
import { assumptionFacts, DEFAULTS } from './rules/defaults';

const AREAS = {
	program,
	defaults,
	blocks,
	strength,
	running,
	placement,
	volume,
	loads,
	edits,
	results
};
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(([, name]) => name!);
const accepted = (decision: unknown) => validate(decisionPlanSchema, decision);

describe('the templates', () => {
	it('cover every decision kind, each in exactly one area file', () => {
		const areasOf = new Map<string, string[]>();
		for (const [area, templates] of Object.entries(AREAS)) {
			for (const kind of Object.keys(templates)) {
				areasOf.set(kind, [...(areasOf.get(kind) ?? []), area]);
			}
		}
		expect([...areasOf.keys()].sort()).toEqual([...DECISION_KINDS].sort());
		expect([...areasOf].filter(([, areas]) => areas.length > 1)).toEqual([]);
		expect(Object.keys(TEMPLATES).sort()).toEqual([...DECISION_KINDS].sort());
	});

	it.each(DECISION_KINDS)('%s renders with no placeholder left, as the plan accepts', (kind) => {
		const { summary, why } = TEMPLATES[kind];
		const names = [...placeholders(summary), ...placeholders(why)];
		const facts = Object.fromEntries(names.map((name) => [name, `<${name}>`]));
		const decision = new DecisionLog().add(kind, 'test.rule', [], facts as never);
		for (const text of [decision.summary, decision.why]) {
			expect(text).not.toMatch(/[{}]/);
			expect(text.trim()).not.toBe('');
		}
		expect(accepted(decision)).toEqual({ ok: true, data: decision });
	});

	it('refuses a decision missing a fact its template names, at compile and at run time', () => {
		const log = new DecisionLog();
		const incomplete = () =>
			// @ts-expect-error: default_assumed also names missing, rationale and section.
			log.add('default_assumed', 'defaults.equipment', [], { assumed: 'a gym' });
		expect(incomplete).toThrow("A 'default_assumed' decision needs the fact 'missing'");
		expect(log.list()).toEqual([]);
	});

	it('fills facts in once: a fact’s own braces are left alone, booleans read yes or no', () => {
		expect(render('{a} {b} {c}', { a: '{b}', b: true, c: 2.5 }, 'progression')).toBe('{b} yes 2.5');
	});
});

describe('DecisionLog', () => {
	it('renders the summary and why, keeps every fact as evidence and names the decider', () => {
		const log = new DecisionLog('owner');
		const facts = {
			who: 'You',
			session: 'Lower A',
			from: 'Mon',
			to: 'Wed',
			reason: NO_REASON,
			warnings: '',
			lineage: 'l-1'
		};
		const moved = log.add('session_moved', 'edits.move', ['blocks.0.weeks.0.sessions.2'], facts);
		expect(moved).toEqual({
			kind: 'session_moved',
			ruleKey: 'edits.move',
			summary: 'Moved Lower A from Mon to Wed',
			why: 'You moved Lower A from Mon to Wed. No reason given.',
			decidedBy: 'owner',
			refs: ['blocks.0.weeks.0.sessions.2'],
			evidence: facts
		});
		expect(new DecisionLog().add('owner_confirmed', 'program.confirmed', [], {}).decidedBy).toBe(
			'rules'
		);
	});

	it('lists decisions by kind, in DECISION_KINDS order, then in the order they were made', () => {
		const log = new DecisionLog();
		const placed = (session: string, day: string) =>
			log.add('session_placed', 'placement.spacing', [], { session, day, reason: 'it is free' });
		placed('Lower A', 'Monday');
		log.add('default_assumed', 'defaults.session_minutes', [], {
			missing: 'You haven’t said.',
			assumed: '60-minute sessions',
			rationale: 'An hour fits.',
			section: 'Schedule'
		});
		placed('Upper A', 'Wednesday');
		log.add('program_purpose', 'program.purpose', [], {
			purpose: 'Week 1 sets baselines.',
			goal: 'your fight'
		});
		expect(log.list().map((d) => [d.kind, d.summary])).toEqual([
			['program_purpose', 'Week 1 establishes your baselines'],
			['default_assumed', 'Assumed 60-minute sessions'],
			['session_placed', 'Lower A on Monday'],
			['session_placed', 'Upper A on Wednesday']
		]);
	});

	it('retargets every decision’s refs, dropping those to nodes no longer planned', () => {
		const log = new DecisionLog();
		const facts = { session: 'Lower A', day: 'Monday', reason: 'it is free' };
		const a = log.add(
			'session_placed',
			'placement.spacing',
			['blocks.0', 'blocks.0.weeks.0.sessions.0'],
			facts
		);
		const b = log.add(
			'session_placed',
			'placement.spacing',
			['blocks.0.weeks.0.sessions.1.exercises.2'],
			facts
		);
		const moves: Record<string, string | null> = {
			'blocks.0.weeks.0.sessions.0': null,
			'blocks.0.weeks.0.sessions.1.exercises.2': 'blocks.0.weeks.0.sessions.0.exercises.2'
		};
		log.retarget((ref) => (ref in moves ? moves[ref]! : ref));
		expect(log.list().map((d) => d.refs)).toEqual([
			['blocks.0'],
			['blocks.0.weeks.0.sessions.0.exercises.2']
		]);
		expect([a.refs, b.refs]).toEqual(log.list().map((d) => d.refs));
	});
});

describe('the defaults as decisions', () => {
	/** Every goal paused, a commitment with nothing but its days, and nothing else told. */
	const profile: TrainingProfile = {
		profile: {
			name: 'Niko',
			weightUnit: 'kg',
			distanceUnit: 'km',
			timeZone: 'UTC',
			birthYear: null,
			nutritionPhase: null,
			targetWeight: null,
			targetDate: null,
			baselinesUnknown: true,
			onboarding: { current: 'review', completed: [], skipped: [], completedAt: null },
			updatedAt: new Date(0)
		},
		bodyWeight: [],
		goals: (['distance_running', 'muay_thai'] as const).map((discipline, n): Goal => ({
			id: `00000000-0000-4000-8000-00000000000${n}`,
			kind: 'general',
			title: discipline === 'muay_thai' ? 'Fight fit' : 'Run far',
			disciplines: [discipline],
			customDiscipline: null,
			status: 'paused',
			priority: n + 1,
			eventType: null,
			eventDate: null,
			weightClass: null,
			targetPerformance: null,
			requirements: null,
			focus: 'Fitness',
			measure: 'Feel',
			targetDate: null,
			notes: null,
			createdAt: new Date(0),
			updatedAt: new Date(0)
		})),
		experience: [],
		baselines: [],
		running: null,
		muayThai: null,
		equipment: null,
		injuries: [],
		exercises: [],
		schedule: {
			daysPerWeek: 4,
			availableDays: [],
			preferredTimes: ['varies'],
			sessionMinutes: null,
			constraints: null,
			commitments: [
				{
					id: '00000000-0000-4000-8000-000000000009',
					discipline: 'running',
					label: 'Run club',
					days: ['wed'],
					timeOfDay: null,
					durationMinutes: null,
					intensity: null,
					notes: null
				}
			],
			updatedAt: null
		}
	};
	const input = buildProgrammingInput(profile, { catalogue: CATALOGUE });

	it('can assume every default in the table, and lists each one it applies', () => {
		const rules = new Set(input.assumptions.map((a) => a.ruleKey));
		expect([...rules]).toEqual(Object.keys(DEFAULTS).map((key) => `defaults.${key}`));
	});

	it('renders each assumption as a complete default_assumed decision', () => {
		const log = new DecisionLog();
		for (const a of input.assumptions)
			log.add('default_assumed', a.ruleKey, [], assumptionFacts(a, input));
		for (const decision of log.list()) {
			expect(`${decision.summary} ${decision.why}`).not.toMatch(/[{}]/);
			expect(decision.why).toMatch(/ Change it in Profile → \S/);
			expect(accepted(decision)).toEqual({ ok: true, data: decision });
		}
		expect(log.list().map((d) => d.summary)).toEqual([
			'Assumed any day of the week',
			'Assumed no set time of day',
			'Assumed 60-minute sessions',
			'Assumed moderate intensity for Run club',
			'Assumed 60 minutes for Run club',
			'Assumed a commercial gym',
			'Assumed you are new to Half-marathon / marathon prep',
			'Assumed you are new to Muay Thai',
			'Assumed runs set by time, not distance',
			'Assumed technical Muay Thai sessions',
			'Assumed maintenance training'
		]);
		expect(log.list()[2]!.why).toBe(
			'You haven’t said how long a session can be. The coach assumed 60-minute sessions. ' +
				'An hour fits a strength session with its warm-up and rests, as onboarding suggests. ' +
				'Change it in Profile → Schedule.'
		);
	});
});
