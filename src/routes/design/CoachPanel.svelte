<!--
  /design: the coach's answer components (loaded when its tab opens), on fixture answers about
  the week of Monday 2 November 2026: every block kind with dated sources, a metric's method, a
  block the policy could not check, a long answer behind 'Show all', untrusted text that must stay
  literal, activity chips in their three states, and an answer streaming block by block into the
  live region.
-->
<script lang="ts">
	import {
		activityLabel,
		type AnswerBlockKind,
		type CompletedBlock,
		type RichBlock,
		type RichInline,
		type SourceRef
	} from '#lib/domain/coach/index.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import ActivityChip from '#lib/ui/coach/ActivityChip.svelte';
	import AnswerBlocks from '#lib/ui/coach/AnswerBlocks.svelte';
	import LiveAnnouncer from '#lib/ui/coach/LiveAnnouncer.svelte';

	const text = (t: string): RichInline => ({ type: 'text', text: t });
	const strong = (t: string): RichInline => ({ type: 'strong', children: [text(t)] });
	const para = (...children: RichInline[]): RichBlock => ({ type: 'paragraph', children });
	const say = (t: string) => [para(text(t))];

	const block = (
		n: number,
		kind: AnswerBlockKind,
		ast: RichBlock[],
		sources: SourceRef[] = [],
		{ method = null, grounded = true }: { method?: string | null; grounded?: boolean } = {}
	): CompletedBlock => ({ block: n, kind, method, ast, sources, grounded });

	const LOWER: SourceRef = {
		type: 'workout',
		id: 'w-lower-1',
		label: 'Lower body strength',
		date: '2026-11-02'
	};
	const TOP_SET: SourceRef = {
		type: 'set',
		id: 's-squat-1',
		workoutId: 'w-lower-1',
		label: 'Back squat top set',
		date: '2026-11-02'
	};
	const SQUAT: SourceRef = { type: 'exercise', id: 'back_squat', label: 'Back squat' };

	const ANSWER: CompletedBlock[] = [
		block(0, 'note', say('Your squat is moving well. Here is what the last two weeks show.')),
		block(
			1,
			'fact',
			[
				para(
					text('You squatted '),
					strong('140 kg × 5'),
					text(' at RPE 8 on '),
					{ type: 'ref', ref: LOWER, label: 'Monday' },
					text('.')
				)
			],
			[LOWER, TOP_SET]
		),
		block(
			2,
			'metric',
			say('Estimated 1RM: 163.3 kg, up 4.1 kg from 159.2 kg on 26 Oct.'),
			[TOP_SET, { type: 'set', id: 's-squat-0', workoutId: 'w-lower-0', date: '2026-10-26' }],
			{ method: 'Epley: weight × (1 + reps ÷ 30), from your best set each week.' }
		),
		block(
			3,
			'recommendation',
			[
				para(text('For Friday:')),
				{
					type: 'list',
					ordered: false,
					children: [
						{ type: 'item', children: [text('Keep the top set at RPE 8.')] },
						{ type: 'item', children: [text('Add one back-off set at 120 kg × 5.')] }
					]
				}
			],
			[SQUAT, { type: 'session', id: 'lower-a', label: 'Lower body strength', date: '2026-11-06' }]
		),
		block(
			4,
			'safety',
			say(
				'Stop the set if the knee pain comes back sharper than 3 out of 10. A box squat to parallel is a gentler option, and a physiotherapist can check the knee.'
			),
			[
				{
					type: 'pain_report',
					id: 'p-knee-1',
					workoutId: 'w-lower-0',
					label: 'Left knee, 2 out of 10',
					date: '2026-10-28'
				}
			]
		),
		block(5, 'note', say('Thursday’s run stays easy, as the plan has it.'), [
			{ type: 'decision', id: 'd-easy-1', label: 'Easy run after a heavy day' },
			{ type: 'date', id: '2026-11-05' }
		])
	];

	const UNCHECKED: CompletedBlock[] = [
		block(0, 'note', say('Your bench press went up 5 kg last week.'), [], { grounded: false })
	];

	const LONG: CompletedBlock[] = Array.from({ length: 15 }, (_, i) =>
		block(
			i,
			i % 3 === 2 ? 'recommendation' : i % 3 === 1 ? 'metric' : 'fact',
			say(`Week ${i + 1}: 4 sessions, 3 h 20 min in total.`)
		)
	);

	/** Untrusted words the server left literal: none of it may become markup or a link. */
	const HOSTILE: CompletedBlock[] = [
		block(
			0,
			'note',
			[
				para(text('<img src=x onerror="alert(1)"> and &amp; stay as written.')),
				para(text('**not bold**, _not italic_ and [a link](https://example.com) too.')),
				para(
					// Split, so the closing tag cannot end this component's own script.
					{ type: 'code', text: '<script>alert(1)</' + 'script>' },
					text(' '),
					{ type: 'link', href: 'javascript:alert(1)', children: [text('not a link')] },
					text(' '),
					{ type: 'link', href: '//example.com/train', children: [text('nor this')] },
					text(' '),
					{ type: 'ref', ref: LOWER, label: '<b>Monday</b>' }
				)
			],
			[{ ...LOWER, label: '<i>Lower body</i>' }]
		)
	];

	const BENCH = activityLabel(
		'get_exercise_history',
		{ exercise: 'Bench press', limit: 6 },
		{
			items: [1, 2, 3, 4, 5, 6]
		}
	);
	const RUNS = activityLabel('get_running_history', { weeks: 4 });

	let opened = $state<string | null>(null);
	const openExercise = (id: string) => (opened = id);

	// Streaming: one more block each press, then the end of the answer.
	let streamed = $state(0);
	const done = $derived(streamed === ANSWER.length);
	const next = () => (streamed = done ? 0 : streamed + 1);
</script>

<div class="grid">
	<Section title="Answer" gap="md">
		<AnswerBlocks blocks={ANSWER} onopenexercise={openExercise} data-testid="answer-full" />
		<p class="readout" data-testid="open-exercise">open-exercise: {opened ?? 'none'}</p>
	</Section>

	<Section title="Not checked" gap="md">
		<AnswerBlocks blocks={UNCHECKED} data-testid="answer-unchecked" />
	</Section>

	<Section title="Long answer" gap="md">
		<AnswerBlocks blocks={LONG} data-testid="answer-long" />
	</Section>

	<Section title="Untrusted text" gap="md">
		<AnswerBlocks blocks={HOSTILE} data-testid="answer-hostile" />
	</Section>

	<Section title="Activity" gap="md">
		<div class="chips" data-testid="activity-states">
			<ActivityChip state="running" label={BENCH.running} />
			<ActivityChip state="done" label={BENCH.done} />
			<ActivityChip state="failed" label={RUNS.failed} />
		</div>
	</Section>

	<Section title="Streaming" gap="md">
		<div class="chips">
			<ActivityChip
				state={streamed === 0 ? 'running' : 'done'}
				label={streamed === 0 ? BENCH.running : BENCH.done}
				data-testid="activity-live"
			/>
		</div>
		<AnswerBlocks blocks={ANSWER.slice(0, streamed)} data-testid="answer-streaming" />
		<LiveAnnouncer blocks={ANSWER.slice(0, streamed)} complete={done} />
		<Button variant="secondary" size="sm" onclick={next} data-testid="stream-next"
			>{done ? 'Start again' : 'Complete the next block'}</Button
		>
	</Section>
</div>

<style>
	.grid {
		display: grid;
		gap: var(--space-6);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.readout {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}
</style>
