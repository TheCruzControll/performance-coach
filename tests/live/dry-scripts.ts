/**
 * What the MockProvider plays for the live suite's messages that no app script matches, so the
 * dry run (LIVE_LLM_DRY=1) walks all six conversations. Each borrows an app script's steps:
 * - 'And my squat?' reads the squat's history and records, as 'squat-increase' does
 * - 'Why didn't you change it?' reads the rejected proposal, as 'after-rejection' does
 * - the steroid request is declined (stop_reason refusal), as 'refusal' is
 * - 'How did my last workout go?' lists the recent workouts, opens the newest and says how it went
 * The rest are the app's own scripts. They come first, so an app script never shadows them.
 */
import type { MockContext, MockScript } from '../../src/lib/server/agent/provider/mock';
import { MOCK_SCRIPTS } from '../../src/lib/server/agent/provider/mock-scripts/index';

const steps = (name: string) => {
	const script = MOCK_SCRIPTS.find((each) => each.name === name);
	if (!script) throw new Error(`No mock script '${name}'`);
	return script.steps;
};

interface Recent {
	items: { source: { id: string } }[];
	workout: { source: { type: string; id: string } } | null;
}
const recent = (context: MockContext) => context.result('get_recent_workouts') as Recent;

const DRY_SCRIPTS: readonly MockScript[] = [
	{
		name: 'live-squat',
		matches: (text) => /^\s*and my squat\??\s*$/i.test(text),
		steps: steps('squat-increase')
	},
	{
		name: 'live-why-not',
		matches: (text) => /\bwhy didn['’]t you change\b/i.test(text),
		steps: steps('after-rejection')
	},
	{ name: 'live-refusal', matches: (text) => /\bsteroid/i.test(text), steps: steps('refusal') },
	{
		name: 'live-last-workout',
		matches: (text) => /\blast workout\b/i.test(text),
		steps: [
			{ tools: [{ name: 'get_recent_workouts', input: {} }] },
			{
				tools: [
					{
						name: 'get_recent_workouts',
						input: (context) => ({ id: recent(context).items[0]?.source.id })
					}
				]
			},
			{
				text: (context) => {
					const source = recent(context).workout?.source;
					return source
						? `[note] Your last workout is logged [[${source.type}:${source.id}]]. Tell me how it felt and I’ll take it from there.`
						: '[note] I couldn’t find a workout in your log yet.';
				}
			}
		]
	}
];

export const LIVE_DRY_SCRIPTS: readonly MockScript[] = [...DRY_SCRIPTS, ...MOCK_SCRIPTS];
