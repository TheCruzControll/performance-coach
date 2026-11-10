<!--
  /design: the coach's answer components (loaded when its tab opens), on fixture answers about
  the week of Monday 2 November 2026: every block kind with dated sources, a metric's method, a
  block the policy could not check, a long answer behind 'Show all', untrusted text that must stay
  literal, activity chips in their three states, and an answer streaming block by block into the
  live region; a proposal card in each of its states, whose Accept applies it here. Then what
  every coach screen reuses around an answer: the composer (ready, running
  with Stop, near its limit and disabled), 'Thinking…', loading rows, every notice with its Retry,
  the empty state and the practice coach's badge.
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
	import ProposalCard from '#lib/ui/coach/ProposalCard.svelte';
	import type { ProposalCardView } from '#lib/domain/coach/cards.ts';
	import LiveAnnouncer from '#lib/ui/coach/LiveAnnouncer.svelte';
	import CoachNotice from '#lib/ui/coach/CoachNotice.svelte';
	import Composer from '#lib/ui/coach/Composer.svelte';
	import LoadingRows from '#lib/ui/coach/LoadingRows.svelte';
	import MockBadge from '#lib/ui/coach/MockBadge.svelte';
	import ThinkingIndicator from '#lib/ui/coach/ThinkingIndicator.svelte';
	import { COACH_ERROR_KINDS, COACH_UNAVAILABLE_REASONS } from '#lib/domain/coach/index.ts';
	import { SCREEN_FAILURE_LABEL, type ScreenFailure } from '#lib/ui/coach/coach-notices.ts';

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

	const PROPOSED: ProposalCardView = {
		id: 'p-split-squat',
		kind: 'program_adjustment',
		status: 'proposed',
		title: 'Replace Bulgarian split squats with reverse lunges',
		rationale:
			'You said you dislike Bulgarian split squats. Reverse lunges train the same single-leg strength and fit the same slot.',
		rows: [
			{
				label: 'Lower body strength, every session from Wed 11 Nov',
				before: 'Bulgarian split squat · 3 × 8',
				after: 'Reverse lunge · 3 × 8 · loads set by RPE',
				date: '2026-11-11'
			},
			{
				label: 'Intervals',
				before: 'Wed 11 Nov, Morning',
				after: 'Fri 13 Nov, Morning',
				date: '2026-11-13'
			},
			{ label: 'Accessory', before: null, after: 'Copenhagen plank · 2 × 20 s', date: null }
		],
		impactLines: ['Week of Mon 9 Nov: Glutes +2 hard sets, +6 min, load +40'],
		warnings: ['Hard legs the day before intervals'],
		appliedVersion: null,
		supersededReason: null
	};
	const CARDS: ProposalCardView[] = [
		{ ...PROPOSED, id: 'p-applied', status: 'applied', appliedVersion: 3 },
		{
			...PROPOSED,
			id: 'p-next-cycle',
			kind: 'next_cycle',
			status: 'accepted',
			title: 'Plan the next block: strength focus',
			rows: [{ label: 'Next block', before: null, after: '4 weeks · strength focus', date: null }],
			impactLines: [],
			warnings: []
		},
		{
			...PROPOSED,
			id: 'p-superseded',
			status: 'superseded',
			supersededReason: 'program_changed',
			impactLines: [],
			warnings: []
		}
	];
	let card = $state(PROPOSED);
	let accepting = $state(false);
	/** Accept here: busy for a moment, then applied as version 4. */
	function acceptCard() {
		accepting = true;
		setTimeout(() => {
			accepting = false;
			card = { ...card, status: 'applied', appliedVersion: 4 };
		}, 600);
	}

	let opened = $state<string | null>(null);
	const openExercise = (id: string) => (opened = id);

	// Streaming: one more block each press, then the end of the answer.
	let streamed = $state(0);
	const done = $derived(streamed === ANSWER.length);
	const next = () => (streamed = done ? 0 : streamed + 1);

	// The composer: what was sent or stopped, so a spec can tell a send from a newline.
	let draft = $state('');
	let composed = $state('none');
	const sent = (text: string) => {
		composed = `sent: ${text}`;
		draft = '';
	};
	const NEAR_LIMIT = 'Here is everything about my week, in detail. '.repeat(86);

	const SCREEN_FAILURES = Object.keys(SCREEN_FAILURE_LABEL) as ScreenFailure[];
	let retried = $state('none');
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

	<Section title="Proposal cards" gap="md">
		<ProposalCard {card} {accepting} onaccept={acceptCard} data-testid="proposal-live" />
		{#each CARDS as each (each.id)}
			<ProposalCard card={each} data-testid="proposal-{each.status}" />
		{/each}
	</Section>

	<Section title="Composer" gap="md">
		<Composer chrome={false} bind:value={draft} onsend={sent} data-testid="composer-ready" />
		<Composer
			chrome={false}
			running
			value="How did my squat go this week?"
			onstop={() => (composed = 'stopped')}
			data-testid="composer-running"
		/>
		<Composer chrome={false} value={NEAR_LIMIT} data-testid="composer-long" />
		<Composer
			chrome={false}
			disabled
			placeholder="Ask your coach · coming soon"
			data-testid="composer-disabled"
		/>
		<p class="readout" data-testid="composer-readout">composer: {composed}</p>
	</Section>

	<Section title="Waiting" gap="md">
		<ThinkingIndicator data-testid="thinking" />
		<LoadingRows label="Loading your conversations…" data-testid="loading-rows" />
	</Section>

	<Section title="Coach unavailable" gap="md">
		{#each COACH_UNAVAILABLE_REASONS as reason (reason)}
			<CoachNotice kind={reason} data-testid="notice-{reason}" />
		{/each}
	</Section>

	<Section title="Turn outcomes" gap="md">
		{#each COACH_ERROR_KINDS as kind (kind)}
			<CoachNotice {kind} onretry={() => (retried = kind)} data-testid="notice-{kind}" />
		{/each}
	</Section>

	<Section title="Screen failures" gap="md">
		{#each SCREEN_FAILURES as kind (kind)}
			<CoachNotice
				{kind}
				onretry={() => (retried = kind)}
				retrying={kind === 'action_failed'}
				data-testid="notice-{kind}"
			/>
		{/each}
		<p class="readout" data-testid="notice-readout">retry: {retried}</p>
	</Section>

	<Section title="Empty and practice" gap="md">
		<CoachNotice kind="empty" data-testid="notice-empty" />
		<MockBadge data-testid="mock-badge" />
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
