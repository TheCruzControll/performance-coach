<!--
  /design: the program display components (loaded when its tab opens), on one fixture week of a
  hybrid plan, Wednesday 4 November 2026 being today: every session state, a card whose link is
  navigating (pending), prescriptions in describe.ts's words, and the Move sheet's body with the
  days left this week and with none left.
-->
<script lang="ts">
	import { addDays, type IsoDate } from '#lib/domain/calendar.ts';
	import { WEEKDAYS } from '#lib/domain/profile/catalog.ts';
	import {
		describePrescription,
		describeSegments,
		type RunSegment,
		type SetPrescription
	} from '#lib/domain/training/index.ts';
	import Section from '#lib/ui/components/Section.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import MoveSheet from '#lib/ui/program/MoveSheet.svelte';
	import PrescriptionLines from '#lib/ui/program/PrescriptionLines.svelte';
	import SessionCard from '#lib/ui/program/SessionCard.svelte';
	import { moveOption } from '#lib/ui/program/session-words.ts';
	import WeekStrip from '#lib/ui/program/WeekStrip.svelte';
	import {
		cardView,
		stripDay,
		type CardSession,
		type CardView,
		type StripDay
	} from '#lib/ui/program/words.ts';

	const MONDAY = '2026-11-02';
	const TODAY = '2026-11-04';

	/** A session on day `day` of the week (0 is Monday). */
	const session = (
		day: number,
		title: string,
		type: CardSession['type'],
		estMinutes: number,
		intensity: CardSession['intensity'],
		timeOfDay: CardSession['timeOfDay'],
		status: CardSession['status'] = 'planned',
		movedFrom: IsoDate | null = null
	): CardSession & { date: IsoDate } => ({
		date: addDays(MONDAY, day),
		title,
		type,
		customDiscipline: null,
		estMinutes,
		intensity,
		timeOfDay,
		status,
		movedFrom
	});

	const SESSIONS = {
		lower: session(0, 'Lower body strength', 'strength', 60, 'hard', 'morning', 'completed'),
		intervals: session(1, 'Intervals', 'interval_run', 45, 'hard', 'morning', 'skipped'),
		thai: session(1, 'Muay Thai class', 'muay_thai', 90, 'hard', 'evening', 'completed'),
		upper: session(2, 'Upper body strength', 'strength', 55, 'moderate', 'morning'),
		mobility: session(2, 'Mobility', 'mobility', 20, 'easy', null, 'moved', MONDAY),
		easy: session(3, 'Easy run', 'easy_run', 30, 'easy', 'morning'),
		thursdayThai: session(3, 'Muay Thai class', 'muay_thai', 90, 'hard', 'evening'),
		long: session(5, 'Long run', 'long_run', 75, 'moderate', 'varies')
	};

	const WEEK: StripDay[] = WEEKDAYS.map((weekday, i) => {
		const date = addDays(MONDAY, i);
		return { date, weekday, sessions: Object.values(SESSIONS).filter((s) => s.date === date) };
	});

	/** In words, as a screen's load composes them. */
	const STRIP = WEEK.map((day) => stripDay(day, TODAY));
	const CARDS = Object.fromEntries(
		Object.entries(SESSIONS).map(([key, s]) => [key, cardView(s)])
	) as Record<keyof typeof SESSIONS, CardView>;

	/** Week findings as Train's load words them (services/periodisation/evaluate.ts). */
	const LEGS =
		'Heavy squats, hinges or a high-volume leg day tire the legs for a day or more: hard Muay Thai on tired legs risks injury, and a long run on them is slower and harder to recover from.';
	const NOTES = [
		{
			card: 'thursdayThai',
			tone: 'caution',
			text: 'Heads-up · Heavy lower body the day before hard Muay Thai · After Lower body strength the day before',
			why: `${LEGS} You moved Lower body strength here from Friday.`
		},
		{
			card: 'long',
			tone: 'neutral',
			text: 'Trade-off, explained · Heavy lower body the day before a long run · After Lower body strength the day before',
			why: `${LEGS} Your marathon ranks ahead of your strength goal, so the long run keeps its day.`
		}
	] as const;

	let selected = $state<IsoDate | null>(TODAY);

	/** Wednesday's Upper body moving: the days after today, each with what is planned there. */
	const MOVE_TO = [3, 4, 5, 6].map((day) => {
		const date = addDays(MONDAY, day);
		const titles = Object.values(SESSIONS)
			.filter((s) => s.date === date)
			.map((s) => s.title);
		return moveOption({ date, planned: titles.join(' · ') || 'Rest day' });
	});
	const MOVING = '00000000-0000-4000-8000-000000000041';

	const set = (over: Partial<SetPrescription>): SetPrescription => ({
		role: 'working',
		sets: 3,
		repsMin: 5,
		repsMax: 5,
		seconds: null,
		metres: null,
		targetRpe: null,
		loadKind: 'rpe_based',
		loadValue: null,
		loadUnit: null,
		loadBasis: null,
		reference1rm: null,
		reference1rmUnit: null,
		restSeconds: 120,
		tempo: null,
		notes: null,
		...over
	});
	const words = (sets: SetPrescription[]) =>
		sets.map((p) => describePrescription(p, { unit: 'kg', oneRepMaxKg: null }));

	// Week 1: a baseline top set, then back-off sets from the estimate it gives (none yet).
	const SQUAT = words([
		set({ role: 'top', sets: 1, targetRpe: 7, restSeconds: 180 }),
		set({ role: 'back_off', loadKind: 'from_e1rm', loadValue: 0.75 })
	]);
	const BENCH = words([
		set({
			targetRpe: 7,
			loadKind: 'percent_1rm',
			loadValue: 0.7,
			loadBasis: 'measured',
			reference1rm: 100,
			reference1rmUnit: 'kg'
		}),
		set({ repsMin: 8, repsMax: 12, targetRpe: 8, restSeconds: 90, tempo: '3010' })
	]);

	const segment = (over: Partial<RunSegment>): RunSegment => ({
		kind: 'easy',
		repeatGroup: null,
		repeats: null,
		distanceMetres: null,
		durationSeconds: null,
		paceMinSecondsPerKm: null,
		paceMaxSecondsPerKm: null,
		hrZone: null,
		targetRpe: null,
		...over
	});
	const INTERVALS = describeSegments(
		[
			segment({ kind: 'warm_up', durationSeconds: 600, hrZone: 2 }),
			segment({
				kind: 'interval',
				repeatGroup: 1,
				repeats: 6,
				distanceMetres: 400,
				paceMinSecondsPerKm: 225,
				paceMaxSecondsPerKm: 240,
				targetRpe: 8
			}),
			segment({ kind: 'recovery', repeatGroup: 1, repeats: 6, durationSeconds: 90, targetRpe: 3 }),
			segment({ kind: 'cool_down', durationSeconds: 600, hrZone: 1 })
		],
		{ distanceUnit: 'km' }
	);
</script>

<div class="grid">
	<Section title="Week strip">
		<WeekStrip days={STRIP} today={TODAY} bind:selected label="Week 1" data-testid="week-strip" />
		<p class="readout" data-testid="week-value">selected: {selected}</p>
	</Section>

	<Section title="Session card">
		<SessionCard session={CARDS.upper} href="#upper" baseline data-testid="card-baseline" />
		<SessionCard session={CARDS.easy} href="#easy" pending data-testid="card-pending" />
		<SessionCard session={CARDS.lower} href="#lower" data-testid="card-done" />
		<SessionCard session={CARDS.intervals} href="#intervals" data-testid="card-skipped" />
		<SessionCard session={CARDS.mobility} href="#mobility" data-testid="card-moved" />
		<!-- Read-only, as an older version shows it: no link. -->
		<SessionCard session={CARDS.thursdayThai} data-testid="card-read-only" />
		<!-- A week finding under its card, as Train renders it (m7/04, train/+page.svelte, where
		     its markup and CSS live so Today and History load none of it): caution, then neutral. -->
		{#each NOTES as note (note.card)}
			<SessionCard
				session={CARDS[note.card]}
				href={note.tone === 'caution' ? '#thai' : undefined}
				data-testid={note.tone === 'caution' ? 'card-note' : 'card-note-tradeoff'}
			/>
			<details class="note" data-tone={note.tone}>
				<summary>{note.text}</summary>
				<p>{note.why}</p>
			</details>
		{/each}
	</Section>

	<Section title="Move sheet">
		<Surface padding="md" data-testid="move-days-fixture">
			<MoveSheet lineage={MOVING} version={1} targets={MOVE_TO} />
		</Surface>
		<Surface padding="md" data-testid="move-empty-fixture">
			<MoveSheet lineage={MOVING} version={1} targets={[]} />
		</Surface>
	</Section>

	<Section title="Prescription lines">
		<Surface padding="md">
			<h3 class="exercise">Back squat</h3>
			<PrescriptionLines label="Back squat" sets={SQUAT} />
		</Surface>
		<Surface padding="md">
			<h3 class="exercise">Bench press</h3>
			<PrescriptionLines label="Bench press" sets={BENCH} />
		</Surface>
		<Surface padding="md">
			<h3 class="exercise">Intervals</h3>
			<PrescriptionLines label="Intervals" steps={INTERVALS} />
		</Surface>
	</Section>
</div>

<style>
	/* Train's note (train/+page.svelte), copied for the reference: keep the two in step. */
	.note {
		margin-top: calc(var(--space-2) * -1);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.note summary {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		min-height: var(--touch-target);
		padding: var(--space-3) var(--space-4);
		list-style: none;
	}

	.note summary::-webkit-details-marker {
		display: none;
	}

	.note summary::before {
		content: '';
		flex: none;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		box-shadow: inset 0 0 0 1.5px;
	}

	.note[data-tone='caution'] summary::before {
		background: var(--color-warning);
	}

	@media (hover: hover) and (pointer: fine) {
		.note summary:hover {
			color: var(--color-text);
			cursor: pointer;
		}
	}

	.note p {
		padding: 0 var(--space-4);
	}

	.grid {
		display: grid;
		gap: var(--space-6);
	}

	.readout {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}

	.exercise {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
	}
</style>
