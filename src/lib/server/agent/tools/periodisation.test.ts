import { describe, expect, it } from 'vitest';
import type { IsoDate } from '../../../domain/calendar.ts';
import { applyWhatIf, type PlacedSession } from './periodisation.ts';

const MON: IsoDate = '2026-11-16';
const TUE: IsoDate = '2026-11-17';

const row = (
	over: Partial<PlacedSession> & Pick<PlacedSession, 'lineage' | 'date'>
): PlacedSession => ({
	timeOfDay: null,
	orderInDay: 1,
	status: 'planned',
	movedFrom: null,
	...over
});

const byLineage = (sessions: readonly PlacedSession[], lineage: string) =>
	sessions.find((s) => s.lineage === lineage)!;

describe('applyWhatIf', () => {
	it('places a session on a day with no time of day last, numbering the day from 1', () => {
		const sessions = [
			row({ lineage: 'a', date: MON, orderInDay: 1 }),
			row({ lineage: 'b', date: TUE, orderInDay: 1 }),
			row({ lineage: 'c', date: TUE, orderInDay: 2 }),
			row({ lineage: 'd', date: TUE, orderInDay: 3 })
		];
		const moved = applyWhatIf(sessions, sessions[0]!, TUE, 'morning');
		expect(byLineage(moved, 'a')).toMatchObject({ date: TUE, timeOfDay: 'morning', orderInDay: 4 });
		expect(byLineage(moved, 'b')).toMatchObject({ date: TUE, orderInDay: 1 });
		expect(byLineage(moved, 'c')).toMatchObject({ date: TUE, orderInDay: 2 });
		expect(byLineage(moved, 'd')).toMatchObject({ date: TUE, orderInDay: 3 });
	});

	it('places a session with no time of day last on a day whose sessions have times', () => {
		const sessions = [
			row({ lineage: 'a', date: MON }),
			row({ lineage: 'b', date: TUE, timeOfDay: 'morning', orderInDay: 1 }),
			row({ lineage: 'c', date: TUE, timeOfDay: 'evening', orderInDay: 2 })
		];
		const moved = applyWhatIf(sessions, sessions[0]!, TUE, null);
		expect(byLineage(moved, 'a')).toMatchObject({ timeOfDay: null, orderInDay: 3 });
		expect(byLineage(moved, 'b')).toMatchObject({ orderInDay: 1 });
		expect(byLineage(moved, 'c')).toMatchObject({ orderInDay: 2 });
	});

	it('goes before the first session on its day with a later time of day, else last', () => {
		const sessions = [
			row({ lineage: 'a', date: MON, timeOfDay: 'morning' }),
			row({ lineage: 'b', date: TUE, timeOfDay: 'early_morning', orderInDay: 1 }),
			row({ lineage: 'c', date: TUE, timeOfDay: 'evening', orderInDay: 2 })
		];
		const midday = applyWhatIf(sessions, sessions[0]!, TUE, 'midday');
		expect(byLineage(midday, 'a')).toMatchObject({ orderInDay: 2 });
		expect(byLineage(midday, 'b')).toMatchObject({ orderInDay: 1 });
		expect(byLineage(midday, 'c')).toMatchObject({ orderInDay: 3 });

		const late = applyWhatIf(sessions, sessions[0]!, TUE, 'evening');
		expect(byLineage(late, 'a')).toMatchObject({ orderInDay: 3 });
	});

	it('marks a moved session moved, from the day it was planned for', () => {
		const sessions = [row({ lineage: 'a', date: MON, timeOfDay: 'morning' })];
		const moved = applyWhatIf(sessions, sessions[0]!, TUE, 'morning');
		expect(byLineage(moved, 'a')).toMatchObject({ status: 'moved', movedFrom: MON });
	});

	it('keeps the first day as movedFrom when a moved session moves again', () => {
		const wed = '2026-11-18';
		const first = applyWhatIf(
			[row({ lineage: 'a', date: MON })],
			row({ lineage: 'a', date: MON }),
			TUE,
			null
		);
		const again = applyWhatIf(first, byLineage(first, 'a'), wed, null);
		expect(byLineage(again, 'a')).toMatchObject({ date: wed, status: 'moved', movedFrom: MON });
	});

	it('plans a session again on the day it was planned for, with movedFrom cleared', () => {
		const sessions = [row({ lineage: 'a', date: MON, timeOfDay: 'morning' })];
		const away = applyWhatIf(sessions, sessions[0]!, TUE, 'morning');
		const back = applyWhatIf(away, byLineage(away, 'a'), MON, 'morning');
		expect(byLineage(back, 'a')).toMatchObject({
			date: MON,
			status: 'planned',
			movedFrom: null
		});
	});
});
