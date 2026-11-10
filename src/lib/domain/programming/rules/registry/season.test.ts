/**
 * The season area (m7/26): each season rule is registered with its live constant, the layout as
 * the season's behaviour, and the windows agree with the phase rules they come from.
 * registry.test.ts checks every entry's source and wording.
 */
import { describe, expect, it } from 'vitest';
import { CAMP_WEEKS } from '../fight-camp';
import { LEAD_WEEKS } from '../priority';
import * as season from '../season';
import { MEET_SEQUENCE } from '../strength-phases';
import { BY_PRIORITY } from '../taper';
import { RULE_BY_ID } from './index';
import { rules } from './season';

const live = (id: string) => {
	const rule = RULE_BY_ID.get(id);
	return rule?.kind === 'constant' ? rule.values : undefined;
};

describe('the season rules', () => {
	it('registers every season constant live, and the layout as a behaviour', () => {
		expect(live('season.window')).toBe(season.WINDOW);
		expect(live('season.overlap')).toBe(season.OVERLAP);
		expect(live('season.recovery')).toBe(season.RECOVERY);
		expect(live('season.fill')).toBe(season.FILL);
		expect(live('season.lead_in')).toBe(season.LEAD_IN);
		expect(live('season.maintenance.paused')).toBe(season.MAINTENANCE.paused);
		expect(live('season.maintenance.short_gap')).toBe(season.MAINTENANCE.shortGap);
		expect(live('season.maintenance.no_building_goal')).toBe(season.MAINTENANCE.noBuildingGoal);
		expect(RULE_BY_ID.get('season.windows')).toMatchObject({
			kind: 'behaviour',
			source: 'src/lib/domain/programming/periodisation/windows.ts#seasonWindows'
		});
		expect(rules).toHaveLength(9);
		expect(rules.every((rule) => RULE_BY_ID.get(rule.id)?.area === 'season')).toBe(true);
	});

	it('takes each window from the lead windows, which the phase rules fill', () => {
		for (const [kind, { weeks }] of Object.entries(LEAD_WEEKS)) {
			expect(season.WINDOW.weeks[kind as keyof typeof LEAD_WEEKS]).toBe(weeks);
		}
		expect(season.WINDOW.weeks.fight).toBe(CAMP_WEEKS.full.max);
		const meetWeeks = Object.values(MEET_SEQUENCE.weeks).reduce((a, b) => a + b, 0);
		expect(season.WINDOW.weeks.meet).toBe(meetWeeks);
		expect(season.WINDOW.taperOnlyUnder).toBe(CAMP_WEEKS.min);
		expect(season.taperOnlyUnder('marathon')).toBe(4);
		expect(season.taperOnlyUnder('fight')).toBe(3);
	});

	it('mini-tapers an overlapped event as a secondary event, and recovers after a fight and a marathon', () => {
		expect(season.OVERLAP.eventInside).toBe(BY_PRIORITY.secondary);
		expect(season.RECOVERY.weeks).toMatchObject({ fight: 1, marathon: 2 });
		expect(season.MAINTENANCE.shortGap.weeks).toBe(4);
	});

	it('knows a keep goal from a building one', () => {
		expect(season.FILL.keep.test('Keep strength')).toBe(true);
		expect(season.FILL.keep.test('maintain my squat')).toBe(true);
		expect(season.FILL.keep.test('Build muscle')).toBe(false);
		expect(season.FILL.keep.test('Keeper training')).toBe(false);
	});
});
