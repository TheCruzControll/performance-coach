/**
 * Today's Status Display in Graphite 2004 (TodayStatus.svelte), in words from the plan the panel
 * already shows (plan.server.ts): the week, today's session (or a rest day) with its line, the
 * week's sessions done against planned, and the connection with the changes waiting to sync. Today's design shows the same data as
 * the week strip and the session cards. Only a week holding today has a display.
 */
import type { OutboxStatus } from '#lib/client/workout/outbox-rules.ts';
import type { StatusDisplayProps } from '#lib/ui/components/StatusDisplay.svelte';

/** The part of the plan's week the display reads (PlanWeek). */
export interface StatusWeek {
	label: string;
	today: string | null;
	days: readonly {
		date: string;
		rest: string | null;
		cards: readonly { title: string; line: string; status: string }[];
	}[];
}

/** The display's words, or null when the week does not hold today (before the program starts). */
export function todayStatus(
	week: StatusWeek,
	online: boolean,
	sync: OutboxStatus | null = null
): StatusDisplayProps | null {
	const day = week.days.find((d) => d.date === week.today);
	if (!day) return null;
	// The session still to do leads; once all are done or skipped, the first of the day.
	const open = day.cards.filter((c) => c.status !== 'completed' && c.status !== 'skipped');
	const lead = open[0] ?? day.cards[0];
	const others = day.cards.length - 1;
	const sessions = week.days.flatMap((d) => d.cards).filter((c) => c.status !== 'skipped');
	const done = sessions.filter((c) => c.status === 'completed').length;
	// The outbox's count, as the resume bar says it (null until the sync engine has read it).
	const queued = !sync
		? 0
		: 'pending' in sync
			? sync.pending
			: 'waiting' in sync
				? sync.waiting
				: 'count' in sync
					? sync.count
					: 0;
	const waiting = `${queued} ${queued === 1 ? 'change' : 'changes'} waiting to sync`;
	return {
		label: 'Today’s session',
		line: week.label,
		big: lead ? lead.title : 'Rest day',
		name: true,
		dim: lead
			? `${lead.line}${others > 0 ? ` · and ${others} more` : ''}`
			: (day.rest ?? 'Recovery is part of the plan.'),
		bar: sessions.length
			? {
					label: 'Sessions done this week',
					start: 'This week',
					end: `${done} of ${sessions.length} done`,
					progress: done / sessions.length
				}
			: null,
		foot: !online
			? {
					icon: 'wifi-off',
					text: queued ? `Offline · ${waiting}` : 'Offline · the plan from your last visit'
				}
			: queued
				? { icon: 'refresh', text: waiting }
				: { icon: 'check', text: 'Plan up to date' }
	};
}
