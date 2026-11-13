/**
 * BlockTimeline as the server renders it: M3's timeline without a season (Today's BuildPreview and
 * desk Today pass none), and with Train's season the goal lanes, the ticked weeks, the counted
 * outline run and the track; while it streams, the lanes' and the track's room held. The region,
 * aria-busy and the loading status are PlanOverviewSheet's (the e2e spec's).
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import BlockTimeline from './BlockTimeline.svelte';
import { seasonView, type SeasonRoad } from './season';
import { timelineView, type TimelinePlan } from './timeline';

const FIGHT = 'f1a7e000-0000-4000-8000-000000000001';
const TODAY = '2026-11-11';

/** A four-week camp from Monday 9 November 2026 (deload in its third week), then a six-week outline. */
const PLAN: TimelinePlan = {
	startsOn: '2026-11-09',
	blocks: [
		{
			phase: 'fight_camp',
			name: 'Fight camp',
			startsOn: '2026-11-09',
			endsOn: '2026-12-06',
			outline: false,
			goalRefs: [FIGHT]
		},
		{
			phase: 'marathon_build',
			name: 'Marathon build',
			startsOn: '2026-12-07',
			endsOn: '2027-01-17',
			outline: true,
			goalRefs: [FIGHT]
		}
	]
};
const BLOCKS = timelineView(PLAN, { today: TODAY, goals: [] });

const ROAD: SeasonRoad = {
	blocks: PLAN.blocks.map((b, i) => ({
		...b,
		label: b.name,
		weeks: b.outline
			? []
			: ['accumulation', 'accumulation', 'deload', 'accumulation'].map((kind, w) => ({
					startsOn: ['2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'][w]!,
					kind
				})),
		goals: [
			{ title: 'Muay Thai fight', mode: i === 0 ? 'primary' : 'secondary' },
			{ title: 'Marathon', mode: i === 0 ? 'secondary' : 'primary' }
		],
		modesNote: null
	})),
	events: [{ goalTitle: 'Muay Thai fight', date: '2026-12-05' }],
	markers: []
};

const html = (props: Partial<Parameters<typeof BlockTimeline>[1]> = {}) =>
	render(BlockTimeline, {
		props: { blocks: BLOCKS, weekHref: (n: number) => `?week=${n}`, ...props }
	}).body;
const text = (body: string) =>
	body
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

describe('BlockTimeline', () => {
	it('without a season: M3’s timeline, every outline week listed, no region, lane or tick', () => {
		const body = html();
		expect(body).not.toContain('class="track');
		expect(body).not.toContain('seasonal');
		expect(body).not.toContain('class="lanes');
		expect(body).not.toContain('class="tick');
		expect(body).not.toMatch(/class="block[^"]*"[^>]*data-tone/);
		expect(body.match(/data-testid="plan-week"/g)).toHaveLength(10);
		expect(text(body)).not.toContain('Weeks 5–10');
	});

	it('with the season: the lanes, the deload’s word, the outline counted, and the track', () => {
		const body = html({ season: seasonView(ROAD, TODAY) });
		expect(body).toMatch(/<ol class="timeline[^"]*seasonal/);
		expect(text(body)).toContain('Goal roles Muay Thai fight · leads Marathon · secondary');
		expect(text(body)).toContain('Goal roles Muay Thai fight · secondary Marathon · leads');
		expect(body).toMatch(/data-lead=""[^>]*class="[^"]*"><span class="goal[^"]*">Muay Thai fight/);
		expect(text(body)).toContain('Week 3 Deload');
		expect(text(body)).toContain('Weeks 5–10 Mon 7 Dec – Sun 17 Jan 6 weeks · Not planned yet');
		expect(body.match(/data-testid="plan-week"/g)).toHaveLength(4);
		expect(body).toMatch(/class="block[^"]*"[^>]*data-tone="build"/);
		expect(body).toMatch(/class="track[^"]*" aria-hidden="true"/);
		expect(body.match(/class="mark[^"]*" data-kind="pin"/g)).toHaveLength(1);
		expect(text(body)).toContain('◆ Muay Thai fight · Sat 5 Dec');
	});

	it('while it streams: the track’s room, and each block’s lanes’ room held', () => {
		const body = html({ season: null, lanes: 3 });
		expect(body).toMatch(/<div class="track[^"]*" aria-hidden="true"><!--\[-1--><!--\]--><\/div>/);
		// The goals and the caption: four lines, in both blocks (this one and the next).
		expect(body.match(/class="lanes[^"]*" style="--lines: 4;"/g)).toHaveLength(2);
		expect(body).not.toContain('class="goal');
	});

	it('while it streams with no open goal: the track’s room, no lanes’ room', () => {
		const body = html({ season: null, lanes: 0 });
		expect(body).toMatch(/class="track[^"]*" aria-hidden="true"/);
		expect(body).not.toContain('class="lanes');
		expect(body).not.toContain('class="tick');
	});
});
