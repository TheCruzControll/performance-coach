/**
 * Programming decisions in words (PRD §5, §9). Every rule that makes a non-trivial choice records
 * it through a DecisionLog, which renders the summary and the 'why' from its kind's template, so
 * the owner, History and the coach (M5) always read the same voice and a 'why' is never empty.
 *
 * Templates are split by area in ./decisions/templates/, one file per owning slice: each later
 * slice may reword only its own file. Together they must cover every DECISION_KINDS entry, which
 * TypeScript checks below. A `{fact}` in a template names a fact the decision must be given, and
 * TypeScript checks that too at every `add`; the facts are stored as the decision's evidence.
 */
import type { DecisionPlan, PlanPath } from '../training/types.ts';
import { DECISION_KINDS } from '../training/vocabulary.ts';
import type { Decider, DecisionKind } from '../training/vocabulary.ts';
import { blocks } from './decisions/templates/blocks.ts';
import { defaults } from './decisions/templates/defaults.ts';
import { edits } from './decisions/templates/edits.ts';
import { loads } from './decisions/templates/loads.ts';
import { placement } from './decisions/templates/placement.ts';
import { program } from './decisions/templates/program.ts';
import { running } from './decisions/templates/running.ts';
import { strength } from './decisions/templates/strength.ts';
import { volume } from './decisions/templates/volume.ts';

export type Fact = number | string | boolean;
export type Facts = Readonly<Record<string, Fact>>;

/** A decision kind's words: what was decided, in one line, and why. */
export interface Template {
	readonly summary: string;
	readonly why: string;
}

/** One area's templates. */
export type Templates = Partial<Record<DecisionKind, Template>>;

export const TEMPLATES = {
	...program,
	...defaults,
	...blocks,
	...strength,
	...running,
	...placement,
	...volume,
	...loads,
	...edits
} satisfies Record<DecisionKind, Template>;

type Placeholders<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
	? Name | Placeholders<Rest>
	: never;
type Words<K extends DecisionKind> =
	(typeof TEMPLATES)[K]['summary'] | (typeof TEMPLATES)[K]['why'];

/** The facts kind K's template names, and any other evidence. */
export type FactsFor<K extends DecisionKind> = Facts & Record<Placeholders<Words<K>>, Fact>;

/** `text` with each `{fact}` filled in from `facts`; a fact it names but is not given throws. */
export function render(text: string, facts: Facts, kind: DecisionKind): string {
	return text.replace(/\{(\w+)\}/g, (_, name: string) => {
		const fact = facts[name];
		if (fact === undefined) throw new Error(`A '${kind}' decision needs the fact '${name}'`);
		return typeof fact === 'boolean' ? (fact ? 'yes' : 'no') : String(fact);
	});
}

/** The decisions one generation or edit makes, all by the same decider. */
export class DecisionLog {
	readonly #decidedBy: Decider;
	readonly #decisions: DecisionPlan[] = [];

	constructor(decidedBy: Decider = 'rules') {
		this.#decidedBy = decidedBy;
	}

	/** Record a decision: `refs` are the plan paths it is about, `facts` fill its template. */
	add<K extends DecisionKind>(
		kind: K,
		ruleKey: string,
		refs: readonly PlanPath[],
		facts: FactsFor<K>
	): DecisionPlan {
		const template: Template = TEMPLATES[kind];
		const decision: DecisionPlan = {
			kind,
			ruleKey,
			summary: render(template.summary, facts, kind),
			why: render(template.why, facts, kind),
			decidedBy: this.#decidedBy,
			refs: [...refs],
			evidence: { ...facts }
		};
		this.#decisions.push(decision);
		return decision;
	}

	/** Every decision: by kind in DECISION_KINDS order, then in the order they were made. */
	list(): DecisionPlan[] {
		const rank = (d: DecisionPlan) => DECISION_KINDS.indexOf(d.kind);
		return [...this.#decisions].sort((a, b) => rank(a) - rank(b));
	}
}
