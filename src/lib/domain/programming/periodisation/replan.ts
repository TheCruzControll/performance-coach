/**
 * Re-plans (m7-plan replan-domain; PRD §5; docs/adr/NNNN-replans-as-versions.md). Pure and
 * deterministic.
 *
 * - replanStart(today, touched): the Monday a regenerating or splicing re-plan starts on
 *   (rules/replan.ts REPLAN_START).
 */
import { addDays, mondayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';

/**
 * The Monday a regenerating or splicing re-plan starts on (REPLAN_START): M3's next Monday (today
 * when today is a Monday), then the first Monday with nothing logged or skipped on or after it.
 */
export function replanStart(today: IsoDate, touched: readonly IsoDate[]): IsoDate {
	let start = mondayOf(today) === today ? today : addDays(mondayOf(today), 7);
	for (const date of [...touched].sort()) if (date >= start) start = addDays(mondayOf(date), 7);
	return start;
}
