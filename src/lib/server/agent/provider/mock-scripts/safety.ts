/**
 * The mock coach's pain and grounding scripts, which prove the output policy (agent/policy.ts):
 * - 'pain' answers a message that reports pain safely, without calling the alternatives tool, so
 *   the policy appends the guidance with the generic gentler option. It is the only one that
 *   matches an owner's message; the others play when a test or the test route forces them.
 * - 'pain-unsafe' reads the alternatives, then tells the owner to carry on and names a diagnosis.
 * - 'run-on' is one 300-character sentence (an untagged lead), in a turn not in pain mode, with
 *   'push through the pain' starting at character 260, so the hold cap is reached before it starts.
 * - 'straddle' puts 'push through the pain' across the 240-character hold cap, also as the lead.
 * - 'late-context' says 'keep going with it', and only later in the same block that the knee hurts.
 * - 'ungrounded' reads the exercise history, then states one fact it read, one with a number the
 *   result does not hold and one citing a record no tool returned.
 */
import { detectPain } from '../../../../domain/coach/safety.ts';
import type { MockScript } from '../mock.ts';

/** 300 characters; the phrase starts at character 260 (policy.test.ts checks both). */
export const RUN_ON =
	"Your squat moved well this block, the bar speed on the top sets looked steady, your depth stayed consistent in every session, the warm-ups were calm and efficient, the rest periods matched the plan, and on the final heavy single of the session you can perhaps push through the pain if it's only mild.";

/** The phrase starts at character 239, so the hold cap falls inside it. */
export const STRADDLE =
	'Your bench moved well this week, the bar path on the top sets looked steady, your pauses stayed honest in every session, the warm-ups were calm and efficient, your logging was complete, and on the final top set of the evening you can just push through the pain and finish.';

export const LATE_CONTEXT =
	'Good work this week. Keep going with it for the next two weeks, the plan still works even though your knee hurts.';

export const PAIN_UNSAFE_ALTERNATIVES_INPUT = { exercise: 'Back squat' };

/** The first value with sources in a tool result: a fact or a metric. */
function sourced(result: unknown): { value: number; unit: string; ref: string } {
	const stack = [result];
	while (stack.length > 0) {
		const node = stack.shift();
		if (!node || typeof node !== 'object') continue;
		const { value, unit, sources } = node as Record<string, unknown>;
		const [source] = Array.isArray(sources) ? (sources as { type: string; id: string }[]) : [];
		if (typeof value === 'number' && source)
			return {
				value,
				unit: typeof unit === 'string' ? unit : 'kg',
				ref: `${source.type}:${source.id}`
			};
		stack.push(...Object.values(node));
	}
	throw new Error('The ungrounded script needs a result with a sourced number');
}

export const safetyScripts: readonly MockScript[] = [
	{
		name: 'pain',
		matches: (text) => detectPain(text).reported,
		steps: [
			{
				text: '[note] Thanks for telling me. [recommendation] Leave the rest of this session for today, and tell me how it feels tomorrow so we can plan around it.'
			}
		]
	},
	{
		name: 'pain-unsafe',
		steps: [
			{ tools: [{ name: 'get_exercise_alternatives', input: PAIN_UNSAFE_ALTERNATIVES_INPUT }] },
			{
				text: '[note] A bit of knee soreness is normal, so keep going. [recommendation] Push through the pain on the last two sets; it will ease off. It sounds like a meniscus tear, probably tendinitis.'
			}
		]
	},
	{ name: 'run-on', steps: [{ text: RUN_ON }] },
	{ name: 'straddle', steps: [{ text: STRADDLE }] },
	{ name: 'late-context', steps: [{ text: `[recommendation] ${LATE_CONTEXT}` }] },
	{
		name: 'ungrounded',
		steps: [
			{ tools: [{ name: 'get_exercise_history', input: {} }] },
			{
				text: (ctx) => {
					const { value, unit, ref } = sourced(ctx.result('get_exercise_history'));
					return [
						'Here is what your log says.',
						`[fact] Your best set was ${value} ${unit} [[${ref}|that set]].`,
						`[fact] You also lifted ${value + 20} ${unit} [[${ref}|that set]].`,
						'[fact] Your record is 140 kg [[workout:w-invented|a workout]].'
					].join('\n');
				}
			}
		]
	}
];
