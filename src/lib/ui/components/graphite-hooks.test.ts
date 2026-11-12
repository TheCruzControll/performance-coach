/**
 * The hooks Graphite 2004 styles the core controls, the shell and the Status Display by
 * (src/lib/ui/styles/graphite.css): each component renders its stable `data-ui` attribute on the
 * element the stylesheet restyles, every hook the stylesheet names is one a component renders, and
 * no other route or component carries one, so nothing outside these components changes when
 * Graphite is chosen and nothing at all changes on today's design (the stylesheet is scoped to it;
 * graphite.test.ts).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRawSnippet, type Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ResumeBar from '../../../routes/(app)/ResumeBar.svelte';
import RestTimer from '../workout/RestTimer.svelte';
import AppNav from './AppNav.svelte';
import Badge from './Badge.svelte';
import BottomSheet from './BottomSheet.svelte';
import Button from './Button.svelte';
import Card from './Card.svelte';
import Chip from './Chip.svelte';
import ChoiceGroup from './ChoiceGroup.svelte';
import ListRow from './ListRow.svelte';
import Notice from './Notice.svelte';
import NumberField from './NumberField.svelte';
import NumberStepper from './NumberStepper.svelte';
import PageHeader from './PageHeader.svelte';
import Section from './Section.svelte';
import SegmentedControl from './SegmentedControl.svelte';
import StatusDisplay from './StatusDisplay.svelte';
import StatusSlot from './StatusSlot.svelte';
import Surface from './Surface.svelte';
import TextArea from './TextArea.svelte';
import TextField from './TextField.svelte';
import Toaster from './Toaster.svelte';
import Toggle from './Toggle.svelte';

const children = createRawSnippet(() => ({ render: () => '<span>Content</span>' }));

/** One rendering of a component: its hook, the tag that must carry it, and the props. */
interface Case {
	name: string;
	hook: string;
	tag: string;
	/** Typed loosely: the cases mix components with different props. */
	component: unknown;
	props: Record<string, unknown>;
	/** Where it lives, when not src/lib/ui/components/<name>.svelte. */
	file?: string;
}

const CASES: Case[] = [
	{ name: 'Button', hook: 'button', tag: 'button', component: Button, props: { children } },
	{
		name: 'Button as a link',
		hook: 'button',
		tag: 'a',
		component: Button,
		props: { href: '/today', variant: 'secondary', children }
	},
	{
		name: 'SegmentedControl',
		hook: 'segmented',
		tag: 'div',
		component: SegmentedControl,
		props: {
			label: 'Units',
			value: 'kg',
			options: [
				{ value: 'kg', label: 'kg' },
				{ value: 'lb', label: 'lb' }
			]
		}
	},
	{
		name: 'ChoiceGroup',
		hook: 'choices',
		tag: 'fieldset',
		component: ChoiceGroup,
		props: { legend: 'Goal', options: [{ value: 'strength', label: 'Strength' }], value: null }
	},
	{
		name: 'NumberStepper',
		hook: 'stepper',
		tag: 'div',
		component: NumberStepper,
		props: { label: 'Reps', value: 5 }
	},
	{
		name: 'NumberField',
		hook: 'field',
		tag: 'div',
		component: NumberField,
		props: { label: 'Body weight', value: 80, unit: 'kg' }
	},
	{
		name: 'TextField',
		hook: 'field',
		tag: 'div',
		component: TextField,
		props: { label: 'Name', value: '' }
	},
	{
		name: 'TextArea',
		hook: 'field',
		tag: 'div',
		component: TextArea,
		props: { label: 'Notes', value: '' }
	},
	{
		name: 'Toggle',
		hook: 'toggle',
		tag: 'div',
		component: Toggle,
		props: { label: 'Reminders' }
	},
	{
		name: 'Chip',
		hook: 'chip',
		tag: 'span',
		component: Chip,
		props: { tone: 'strength', children }
	},
	{ name: 'Badge', hook: 'badge', tag: 'span', component: Badge, props: { children } },
	{ name: 'Surface', hook: 'surface', tag: 'div', component: Surface, props: { children } },
	{
		name: 'Surface as a link',
		hook: 'surface',
		tag: 'a',
		component: Surface,
		props: { href: '/today', children }
	},
	{
		name: 'Card',
		hook: 'card-head',
		tag: 'header',
		component: Card,
		props: { title: 'This week', children }
	},
	{
		name: 'Section',
		hook: 'section',
		tag: 'section',
		component: Section,
		props: { title: 'Tools', children }
	},
	{
		name: 'ListRow as a link',
		hook: 'list-row',
		tag: 'a',
		component: ListRow,
		props: { title: 'History', icon: 'clock', href: '/train/history' }
	},
	{
		name: 'ListRow as a button',
		hook: 'list-row',
		tag: 'button',
		component: ListRow,
		props: { title: 'Export', icon: 'clock', onclick: () => {} }
	},
	{
		name: 'ListRow not yet available',
		hook: 'list-row',
		tag: 'div',
		component: ListRow,
		props: { title: 'Import', icon: 'clock', disabled: true }
	},
	{
		name: 'Notice',
		hook: 'notice',
		tag: 'div',
		component: Notice,
		props: { tone: 'danger', children }
	},
	{ name: 'Toaster', hook: 'toaster', tag: 'div', component: Toaster, props: {} },
	{
		name: 'BottomSheet',
		hook: 'sheet',
		tag: 'dialog',
		component: BottomSheet,
		props: { open: false, title: 'Substitute exercise', children }
	},
	{
		name: 'AppNav',
		hook: 'nav',
		tag: 'nav',
		component: AppNav,
		props: { items: [{ href: '/today', label: 'Today', icon: 'today' }], pathname: '/today' }
	},
	{
		name: 'PageHeader',
		hook: 'page-header',
		tag: 'header',
		component: PageHeader,
		props: { title: 'Today', eyebrow: 'Wednesday 11 November', dated: true }
	},
	{
		name: 'ResumeBar',
		hook: 'resume-slot',
		tag: 'div',
		component: ResumeBar,
		props: { pathname: '/today' },
		file: 'src/routes/(app)/ResumeBar.svelte'
	},
	{
		name: 'RestTimer',
		hook: 'rest',
		tag: 'section',
		component: RestTimer,
		props: {
			rest: { startedAt: 0, durationMs: 90_000, pausedAt: 30_000, addedMs: 0 },
			onpause: () => {},
			onresume: () => {},
			onreset: () => {},
			onadd: () => {},
			onclear: () => {}
		},
		file: 'src/lib/ui/workout/RestTimer.svelte'
	},
	{
		name: 'StatusDisplay',
		hook: 'status',
		tag: 'section',
		component: StatusDisplay,
		props: { label: 'Run status', line: 'Segment 1 of 3 · Easy', big: '5:12', unit: '/km' }
	},
	{
		name: 'StatusSlot',
		hook: 'status-room',
		tag: 'div',
		component: StatusSlot,
		props: { load: () => Promise.reject(new Error('not on the server')), props: {}, room: '10rem' }
	}
];

/** The opening tags in server-rendered HTML that carry `data-ui="<hook>"`, by tag name. */
const hooked = (html: string, hook: string) =>
	[...html.matchAll(new RegExp(`<([a-z]+)\\b[^>]*\\bdata-ui="${hook}"`, 'g'))].map(
		([, tag]) => tag
	);

/** The hooks graphite.css restyles. */
const STYLED = new Set(
	[
		...readFileSync(new URL('../styles/graphite.css', import.meta.url), 'utf8').matchAll(
			/\[data-ui='([\w-]+)'\]/g
		)
	].map(([, hook]) => hook!)
);

describe('the hooks Graphite restyles the core controls by', () => {
	for (const { name, hook, tag, component, props } of CASES) {
		it(`${name} renders data-ui="${hook}" on its <${tag}>`, () => {
			const { body } = render(component as Component<Record<string, unknown>>, { props });
			expect(hooked(body, hook)).toEqual([tag]);
		});
	}

	it('are exactly the hooks graphite.css names', () => {
		expect(new Set(CASES.map((c) => c.hook))).toEqual(STYLED);
	});

	it('are carried by these components alone, so no other markup opts into Graphite', () => {
		const carriers = execFileSync(
			'git',
			['grep', '-l', '--untracked', '-E', 'data-ui=', '--', 'src', ':!*.test.ts', ':!*.css'],
			{ encoding: 'utf8' }
		)
			.split('\n')
			.filter(Boolean);
		const files = new Set(
			CASES.map((c) => c.file ?? `src/lib/ui/components/${c.name.split(' ')[0]}.svelte`)
		);
		expect(new Set(carriers)).toEqual(files);
	});
});

describe('the shell and the Status Display', () => {
	const html = (component: unknown, props: Record<string, unknown>) =>
		render(component as Component<Record<string, unknown>>, { props }).body;

	it('PageHeader marks a date eyebrow, the one Graphite keeps as the subtitle', () => {
		const dated = html(PageHeader, {
			title: 'Today',
			eyebrow: 'Wednesday 11 November',
			dated: true
		});
		expect(dated).toMatch(/<p class="eyebrow" data-date="true">Wednesday 11 November<\/p>/);
		const plain = html(PageHeader, { title: 'Train', eyebrow: 'Program' });
		expect(plain).toMatch(/<p class="eyebrow">Program<\/p>/);
	});

	it('StatusSlot is an empty, hidden room on the server: today’s design paints nothing there', () => {
		const room = html(StatusSlot, {
			load: () => Promise.reject(new Error('never on the server')),
			props: {},
			room: '10.5rem'
		});
		// Nothing inside it but the markers of the display to come.
		expect(room).toMatch(/^(<!--[^>]*-->)*<div [^>]*>(<!--[^>]*-->)*<\/div>(<!--[^>]*-->)*$/);
		expect(room).toContain('data-ui="status-room"');
		expect(room).toContain('hidden=""');
		expect(room).toContain('style="--status-room: 10.5rem;"');
	});

	it('StatusDisplay says every part in words, the bar as a named progress bar', () => {
		const body = html(StatusDisplay, {
			label: 'Today’s session',
			line: 'Week 1',
			big: 'Full body',
			name: true,
			dim: 'Strength · 60 min · Moderate',
			bar: {
				label: 'Sessions done this week',
				start: 'This week',
				end: '1 of 4 done',
				progress: 0.25
			},
			foot: { icon: 'check', text: 'Plan up to date' }
		});
		expect(body).toContain('aria-label="Today’s session"');
		expect(body).toContain('data-kind="name"');
		expect(body).toContain('role="progressbar"');
		expect(body).toContain('aria-label="Sessions done this week"');
		expect(body).toContain('aria-valuenow="25"');
		expect(body).toContain('aria-valuetext="1 of 4 done"');
		expect(body).toContain('transform: scaleX(0.25)');
		for (const words of ['Week 1', 'Full body', 'Strength · 60 min · Moderate', 'Plan up to date'])
			expect(body).toContain(words);
		const numeral = html(StatusDisplay, {
			label: 'Run status',
			line: 'Run',
			big: '5:12',
			unit: '/km'
		});
		expect(numeral).toContain('data-kind="numeral"');
		expect(numeral).not.toContain('progressbar');
	});
});
