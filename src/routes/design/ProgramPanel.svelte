<!--
  /design: the program display components (loaded when its tab opens), on one fixture week of a
  hybrid plan, Wednesday 4 November 2026 being today: every session state, a card whose link is
  navigating (pending), and prescriptions in describe.ts's words.
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
	import PrescriptionLines from '#lib/ui/program/PrescriptionLines.svelte';
	import SessionCard from '#lib/ui/program/SessionCard.svelte';
	import WeekStrip from '#lib/ui/program/WeekStrip.svelte';
	import type { CardSession, StripDay } from '#lib/ui/program/words.ts';

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

	let selected = $state<IsoDate | null>(TODAY);

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
		<WeekStrip days={WEEK} today={TODAY} bind:selected label="Week 1" data-testid="week-strip" />
		<p class="readout" data-testid="week-value">selected: {selected}</p>
	</Section>

	<Section title="Session card">
		<SessionCard session={SESSIONS.upper} href="#upper" baseline data-testid="card-baseline" />
		<SessionCard session={SESSIONS.easy} href="#easy" pending data-testid="card-pending" />
		<SessionCard session={SESSIONS.lower} href="#lower" data-testid="card-done" />
		<SessionCard session={SESSIONS.intervals} href="#intervals" data-testid="card-skipped" />
		<SessionCard session={SESSIONS.mobility} href="#mobility" data-testid="card-moved" />
		<!-- Read-only, as an older version shows it: no link. -->
		<SessionCard session={SESSIONS.thursdayThai} data-testid="card-read-only" />
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
