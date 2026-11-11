/**
 * prepare (m7-stage-list, generator-season): what M3's generator and M6's next block do with what
 * it returns: every stage reads its input, the draft starts with its periodisation, and the title
 * and the fingerprint keep the original input. Its own season, order and modes are tested in
 * ../generate-season.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOGUE } from '../../exercises/index';
import { DecisionLog } from '../decisions';
import { generateProgram, STAGES } from '../generate';
import { buildProgrammingInput } from '../input';
import type { ProgrammingInput } from '../input';
import { nextBlockDates } from '../next-block/dates';
import { generateNextBlock } from '../next-block/generate';
import { nextBlockInput } from '../next-block/input';
import type { CycleDirectives } from '../review/directives';
import { SCENARIO_START, SCENARIOS, scenarioDay } from '../scenarios';
import type { Draft, Periodisation, StageContext } from '../stage';
import * as stages from './prepare';

const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
const inputOf = () => buildProgrammingInput(SCENARIOS.hybrid(), { catalogue: CATALOGUE });
const realPrepare = stages.prepare;

/** prepare as it is, but returning a copy of its input with the goals renamed. */
function prepareRenaming() {
	const given: ProgrammingInput[] = [];
	const returned: ProgrammingInput[] = [];
	const periodisations: (Periodisation | null)[] = [];
	vi.spyOn(stages, 'prepare').mockImplementation((input, options, log) => {
		given.push(input);
		const real = realPrepare(input, options, log);
		const prepared = {
			...real.input,
			goals: real.input.goals.map((g) => ({ ...g, title: 'Renamed' }))
		};
		returned.push(prepared);
		periodisations.push(real.periodisation);
		return { input: prepared, periodisation: real.periodisation };
	});
	return { given, returned, periodisations };
}

/** Every stage's draft and context, as `list` runs them. */
function watch(list: readonly { name: string; run: (d: Draft, c: StageContext) => Draft }[]) {
	const seen: { draft: Draft; context: StageContext }[] = [];
	for (const stage of list) {
		const run = stage.run;
		vi.spyOn(stage, 'run').mockImplementation((draft, context) => {
			seen.push({ draft, context });
			return run(draft, context);
		});
	}
	return seen;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('prepare', () => {
	it('is the identity, with no periodisation and no decision, when no goal shapes the plan', () => {
		const input = inputOf();
		const none = {
			...input,
			goals: [],
			paused: [],
			refs: { ...input.refs, goals: [], paused: [] }
		};
		const log = new DecisionLog();
		expect(stages.prepare(none, OPTIONS, log)).toEqual({ input: none, periodisation: null });
		expect(log.list()).toEqual([]);
	});
});

describe('generateProgram with prepare', () => {
	it('runs every stage on the input prepare returns, from a draft with its periodisation', () => {
		const { given, returned, periodisations } = prepareRenaming();
		const seen = watch(STAGES);
		const input = inputOf();
		const plan = generateProgram(input, OPTIONS);
		expect(given).toEqual([input]);
		expect(seen).toHaveLength(STAGES.length);
		for (const { context } of seen) expect(context.input).toBe(returned[0]);
		expect(periodisations[0]).not.toBeNull();
		expect(seen[0]!.draft).toEqual({ demand: null, blocks: [], periodisation: periodisations[0] });
		// The title keeps the original input's goals.
		expect(plan.title).toBe(input.goals.map((g) => g.title).join(' · '));
	});

	it('starts from a draft with no periodisation key while none is planned', () => {
		vi.spyOn(stages, 'prepare').mockImplementation((input) => ({ input, periodisation: null }));
		const seen = watch(STAGES);
		generateProgram(inputOf(), OPTIONS);
		expect(Object.keys(seen[0]!.draft)).toEqual(['demand', 'blocks']);
	});
});

describe('generateNextBlock with prepare', () => {
	/** The hybrid's first block, reviewed on time, and its next block's arguments. */
	function arguments_() {
		const input = inputOf();
		const first = generateProgram(input, OPTIONS);
		const previous = first.blocks[0]!;
		const outline = first.blocks[1] ?? null;
		const directives: CycleDirectives = {
			...{ fromBlockLineage: '5b3c3d0e-8f5a-4a43-9a9c-2f0f6a1c0b01', weeks: 4 },
			...{ phase: outline?.phase ?? previous.phase, fromOutline: outline !== null },
			...{ keep: [], rotate: [], volume: [], rpe: [7, 8.5], deload: 'none', running: null },
			...{ avoidDays: [], progression: 'progress' }
		};
		const dates = nextBlockDates({
			blocks: first.blocks,
			reviewedBlock: 0,
			today: scenarioDay(6, 0),
			start: 'this_week',
			events: [],
			weeks: 4
		});
		const snapshot = { timeZone: 'UTC', e1rms: [], maxes: [], running: null };
		const next = nextBlockInput(input, snapshot, directives);
		const options = {
			dates,
			outline,
			previous: { block: previous, results: [], unit: 'kg' as const },
			directives
		};
		return { next, options };
	}

	it('runs its stages on the input prepare returns, and fingerprints the original input', () => {
		const { next, options } = arguments_();
		const plain = generateNextBlock(next, options);
		const { given, returned, periodisations } = prepareRenaming();
		const run = vi.spyOn(
			STAGES.find((s) => s.name === 'demand')!,
			'run'
		);
		const prepared = generateNextBlock(next, options);
		expect(given).toEqual([next.input]);
		expect(run).toHaveBeenCalledOnce();
		const [draft, context] = run.mock.calls[0]!;
		expect(context.input).toBe(returned[0]);
		expect(draft).toEqual({ demand: null, blocks: [], periodisation: periodisations[0] });
		expect(prepared.fingerprint).toBe(plain.fingerprint);
	});
});
