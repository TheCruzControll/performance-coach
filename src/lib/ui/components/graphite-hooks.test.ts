/**
 * The hooks Graphite 2004 styles the core controls by (src/lib/ui/styles/graphite.css): each
 * component renders its stable `data-ui` attribute on the element the stylesheet restyles, every
 * hook the stylesheet names is one a component renders, and no route or other component carries
 * one, so nothing outside these components changes when Graphite is chosen and nothing at all
 * changes on today's design (the stylesheet is scoped to it; graphite.test.ts).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRawSnippet, type Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
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
import Section from './Section.svelte';
import SegmentedControl from './SegmentedControl.svelte';
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
			.filter(Boolean)
			.map((file) => file.replace('src/lib/ui/components/', '').replace('.svelte', ''));
		const named = new Set(CASES.map((c) => c.name.split(' ')[0]));
		expect(new Set(carriers)).toEqual(named);
	});
});
