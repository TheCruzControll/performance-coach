/**
 * The output gate between the answer parser and the wire (the turn's hook): what of the model's
 * text may be sent, when, and as what. A stub that passes every block through as written, with
 * facts and metrics marked unchecked (grounded: false) and nothing held. output-policy replaces
 * this file: the pain gate holds and rewrites unsafe blocks, and grounding checks each fact and
 * metric against the turn's tool outputs and the snapshot, recording each intervention.
 */
import type { BetaUserMessageParam } from '@anthropic-ai/sdk/resources/beta/messages';
import type { AnswerParserEvent } from '../../domain/coach/answer.ts';
import type { CoachEvent } from '../../domain/coach/events.ts';
import { parseRich } from '../../domain/coach/markdown.ts';
import type { ToolCallOutcome } from './tools/execute.ts';

export interface PolicyInput {
	painMode: boolean;
	/** The segment's memory preamble, as stored: the snapshot's ids are citable too. */
	preamble: BetaUserMessageParam;
}

/** A change the policy made, stored as a '_policy' tool-call row. */
export interface PolicyIntervention {
	block: number;
	reason: 'safety' | 'ungrounded';
	/** Codes and counts only, never text. */
	detail: Record<string, unknown>;
}

export interface OutputPolicy {
	/** Parser events in; the events the wire may carry now. */
	push(events: readonly AnswerParserEvent[]): CoachEvent[];
	/** A step's tool outcomes: what this turn's facts may cite. */
	observe(outcomes: readonly ToolCallOutcome[]): void;
	/** The answer has ended: whatever was held, and any block the answer still owes. */
	end(): CoachEvent[];
	/** The interventions so far. */
	readonly interventions: readonly PolicyIntervention[];
}

const CHECKED_KINDS = new Set(['fact', 'metric']);

export function createOutputPolicy(_input: PolicyInput): OutputPolicy {
	return {
		push: (events) =>
			events.map((event): CoachEvent => {
				if (event.type === 'block_started') return event;
				if (event.type === 'text')
					return { type: 'text_delta', block: event.block, text: event.text };
				return {
					type: 'block_completed',
					block: event.block,
					kind: event.kind,
					method: event.method,
					ast: parseRich(event.raw),
					sources: event.refs,
					grounded: !CHECKED_KINDS.has(event.kind)
				};
			}),
		observe: () => {},
		end: () => [],
		interventions: []
	};
}
