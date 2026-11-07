import { describe, expect, it } from 'vitest';
import type { RichItem, RichList, RichNode, SourceRef } from '#lib/domain/coach/index.ts';
import {
	ANSWER_BLOCKS_SHOWN,
	blockAnnouncement,
	plainText,
	sourceDate,
	sourceName,
	sourceWords
} from './answer-words.ts';

describe('sourceDate', () => {
	it('writes a calendar day with its weekday and year, whatever the device’s zone', () => {
		expect(sourceDate('2026-11-03')).toBe('Tue 3 Nov 2026');
		expect(sourceDate('2027-01-01')).toBe('Fri 1 Jan 2027');
		expect(sourceDate('2028-02-29')).toBe('Tue 29 Feb 2028');
	});

	it('is null for a missing, malformed or impossible day', () => {
		expect(sourceDate(undefined)).toBeNull();
		expect(sourceDate('2026-11-3')).toBeNull();
		expect(sourceDate('2027-02-29')).toBeNull();
		expect(sourceDate('yesterday')).toBeNull();
	});
});

describe('sourceWords and sourceName', () => {
	it('name a dated source by its label, its kind and its day, in reading order', () => {
		const ref: SourceRef = {
			type: 'workout',
			id: 'w1',
			label: 'Lower body strength',
			date: '2026-11-02'
		};
		expect(sourceWords(ref)).toEqual({
			title: 'Lower body strength',
			kind: 'Workout',
			date: 'Mon 2 Nov 2026',
			day: '2026-11-02'
		});
		expect(sourceName(ref)).toBe('Lower body strength, Workout, Mon 2 Nov 2026');
	});

	it('leave out a day the source does not have', () => {
		expect(sourceName({ type: 'exercise', id: 'back_squat', label: 'Back squat' })).toBe(
			'Back squat, Exercise'
		);
		const impossible: SourceRef = { type: 'run', id: 'r1', label: 'Easy run', date: '2026-13-01' };
		expect(sourceWords(impossible)).toEqual({
			title: 'Easy run',
			kind: 'Run',
			date: null,
			day: null
		});
	});

	it('never show a raw id: an unlabelled source is named by its kind', () => {
		const ref: SourceRef = {
			type: 'set',
			id: '0b9c2f1e-1111-4000-8000-000000000001',
			date: '2026-11-02'
		};
		expect(sourceName(ref)).toBe('Set, Mon 2 Nov 2026');
		expect(sourceName({ type: 'goal', id: 'g-7', label: '  ' })).toBe('Goal');
		expect(sourceName({ type: 'goal', id: 'g-7' })).not.toContain('g-7');
	});

	it('name a date source by its day', () => {
		expect(sourceWords({ type: 'date', id: '2026-11-04' })).toEqual({
			title: 'Wed 4 Nov 2026',
			kind: 'Date',
			date: null,
			day: null
		});
		expect(sourceName({ type: 'date', id: '2026-11-04' })).toBe('Wed 4 Nov 2026, Date');
	});
});

describe('plainText', () => {
	it('joins every node’s words, refs by their labels, blocks with a space', () => {
		const ast: RichNode[] = [
			{
				type: 'paragraph',
				children: [
					{ type: 'text', text: 'Your ' },
					{ type: 'strong', children: [{ type: 'text', text: 'squat' }] },
					{ type: 'text', text: ' went up on ' },
					{ type: 'ref', ref: { type: 'workout', id: 'w1' }, label: 'Monday' },
					{ type: 'text', text: '.' }
				]
			},
			{
				type: 'list',
				ordered: false,
				children: [
					{ type: 'item', children: [{ type: 'code', text: '3 × 5' }] },
					{
						type: 'item',
						children: [
							{
								type: 'link',
								href: '/train',
								children: [{ type: 'emphasis', children: [{ type: 'text', text: 'Train' }] }]
							}
						]
					}
				]
			}
		];
		expect(plainText(ast)).toBe('Your squat went up on Monday. 3 × 5 Train');
	});

	it('keeps markup-looking text exactly as written', () => {
		const text = '<img src=x onerror=alert(1)> **not bold**';
		expect(plainText([{ type: 'paragraph', children: [{ type: 'text', text }] }])).toBe(text);
	});

	it('keeps a nested list’s first word apart from its parent item’s last', () => {
		// What parseRich reads from '- Lower body\n  - Squat\n  - Deadlift\n- Upper body'.
		const item = (text: string, nested: RichList[] = []): RichItem => ({
			type: 'item',
			children: [{ type: 'text', text }, ...nested]
		});
		const ast: RichNode[] = [
			{
				type: 'list',
				ordered: false,
				children: [
					item('Lower body', [
						{ type: 'list', ordered: false, children: [item('Squat'), item('Deadlift')] }
					]),
					item('Upper body')
				]
			}
		];
		expect(plainText(ast)).toBe('Lower body Squat Deadlift Upper body');
	});
});

describe('blockAnnouncement', () => {
	const ast: RichNode[] = [
		{ type: 'paragraph', children: [{ type: 'text', text: 'Rest today.' }] }
	];

	it('says the block’s label, then its words', () => {
		expect(blockAnnouncement({ kind: 'recommendation', ast, grounded: true })).toBe(
			'Recommendation: Rest today.'
		);
		expect(blockAnnouncement({ kind: 'metric', ast, grounded: true })).toBe(
			'Calculated: Rest today.'
		);
	});

	it('says when a block was not checked against the owner’s data', () => {
		expect(blockAnnouncement({ kind: 'note', ast, grounded: false })).toBe(
			'Note: Rest today. (Not checked against your data)'
		);
	});
});

it('shows 12 blocks before Show all', () => {
	expect(ANSWER_BLOCKS_SHOWN).toBe(12);
});
