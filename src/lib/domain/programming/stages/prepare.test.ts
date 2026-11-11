/**
 * prepare (m7-stage-list): today the identity with no periodisation; and what M3's generator and
 * M6's next block do with what it returns: every stage reads its input, the draft starts with its
 * periodisation, and the title and the fingerprint keep the original input.
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
/** A periodisation no stage reads yet: prepare's to hand on, whatever it holds. */
const PERIODISATION = {
	season: { blocks: [], dosesByWeek: [], decisions: [] },
	prioritiesByWeek: [],
	dosesByWeek: []
} satisfies Periodisation;

/** prepare returning a copy of the input with its goals renamed, and PERIODISATION. */
function prepareRenaming() {
	const given: ProgrammingInput[] = [];
	const returned: ProgrammingInput[] = [];
	vi.spyOn(stages, 'prepare').mockImplementation((input) => {
		given.push(input);
		const prepared = { ...input, goals: input.goals.map((g) => ({ ...g, title: 'Renamed' })) };
		returned.push(prepared);
		return { input: prepared, periodisation: PERIODISATION };
	});
	return { given, returned };
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
	it('is the identity for now, with no periodisation', () => {
		const input = inputOf();
		expect(stages.prepare(input, OPTIONS, new DecisionLog())).toEqual({
			input,
			periodisation: null
		});
	});
});

describe('generateProgram with prepare', () => {
	it('runs every stage on the input prepare returns, from a draft with its periodisation', () => {
		const { given, returned } = prepareRenaming();
		const seen = watch(STAGES);
		const input = inputOf();
		const plan = generateProgram(input, OPTIONS);
		expect(given).toEqual([input]);
		expect(seen).toHaveLength(STAGES.length);
		for (const { context } of seen) expect(context.input).toBe(returned[0]);
		expect(seen[0]!.draft).toEqual({ demand: null, blocks: [], periodisation: PERIODISATION });
		// The title keeps the original input's goals.
		expect(plan.title).toBe(input.goals.map((g) => g.title).join(' · '));
	});

	it('starts from a draft with no periodisation key while none is planned', () => {
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
		const { given, returned } = prepareRenaming();
		const run = vi.spyOn(
			STAGES.find((s) => s.name === 'demand')!,
			'run'
		);
		const prepared = generateNextBlock(next, options);
		expect(given).toEqual([next.input]);
		expect(run).toHaveBeenCalledOnce();
		const [draft, context] = run.mock.calls[0]!;
		expect(context.input).toBe(returned[0]);
		expect(draft).toEqual({ demand: null, blocks: [], periodisation: PERIODISATION });
		expect(prepared.fingerprint).toBe(plain.fingerprint);
	});
});
