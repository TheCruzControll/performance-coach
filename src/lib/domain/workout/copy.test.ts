import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { BODY_AREAS, EQUIPMENT } from '../profile/catalog';
import * as copy from './copy';
import source from './copy.ts?raw';
import { QUICK_ACTIONS } from './substitution';

/** What the pain copy must never say (the brief: never 'push through'). */
const PUSH_THROUGH =
	/push (through|on)|work through|power through|tough it out|keep going|no pain,? no gain|ignore (the )?pain|shake it off/i;
/** Words that name a diagnosis, which the app never makes. */
const DIAGNOSIS = /diagnos|tendin|tear|sprain|strain|fracture|impinge/i;

/** Every string literal and template piece in copy.ts's source, import paths aside. */
function literals(text: string): string[] {
	const file = ts.createSourceFile('copy.ts', text, ts.ScriptTarget.Latest, true);
	const found: string[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
		if (
			ts.isStringLiteralLike(node) ||
			ts.isTemplateHead(node) ||
			ts.isTemplateMiddle(node) ||
			ts.isTemplateTail(node)
		) {
			found.push(node.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

/** Arguments every exported function is rendered with, so each of its branches is scanned. */
const SAMPLES: Record<string, unknown[][]> = {
	needsLine: [[[]], [['machines']], [[...EQUIPMENT]]],
	dislikeConfirmation: [
		[{ exercise: 'Leg press', replacement: 'Hack squat' }, true],
		[{ exercise: 'Leg press', replacement: 'Hack squat' }, false]
	],
	gentlerHeading: BODY_AREAS.map((area) => [area]),
	noGentler: BODY_AREAS.map((area) => [area])
};

/** Every string a value holds or renders; a function without samples fails the test. */
function rendered(value: unknown, path: string): string[] {
	if (typeof value === 'string') return [value];
	if (typeof value === 'function') {
		const samples = SAMPLES[path];
		if (!samples) throw new Error(`copy.test.ts has no sample arguments for ${path}`);
		return samples.flatMap((args) => rendered(value(...args), `${path}()`));
	}
	if (value && typeof value === 'object') {
		return Object.entries(value).flatMap(([key, v]) => rendered(v, path ? `${path}.${key}` : key));
	}
	return [];
}

const LITERALS = literals(source);
const RENDERED = rendered(copy, '');
const EVERY = [...LITERALS, ...RENDERED];
const PAIN = [
	...rendered(copy.PAIN_COPY, 'PAIN_COPY'),
	...rendered(copy.SEVERITY_COPY, 'SEVERITY_COPY'),
	...rendered({ gentlerHeading: copy.gentlerHeading, noGentler: copy.noGentler }, '')
];

describe('the quick-action copy', () => {
	it('scans something real: the patterns catch each phrase they name, and the module has its words', () => {
		for (const phrase of [
			'Push through it',
			'push on',
			'Work through the pain',
			'power through',
			'Tough it out',
			'Keep going!',
			'No pain, no gain',
			'no pain no gain',
			'Ignore the pain',
			'ignore pain',
			'Shake it off'
		]) {
			expect(PUSH_THROUGH.test(phrase), phrase).toBe(true);
		}
		for (const word of [
			'diagnosis',
			'Tendinitis',
			'a tear',
			'sprain',
			'strained',
			'fracture',
			'impingement'
		]) {
			expect(DIAGNOSIS.test(word), word).toBe(true);
		}
		expect(LITERALS.length).toBeGreaterThan(40);
		expect(RENDERED.length).toBeGreaterThan(LITERALS.length / 2);
	});

	it('never suggests carrying on through pain, in any string written or rendered', () => {
		expect(EVERY.filter((s) => PUSH_THROUGH.test(s))).toEqual([]);
	});

	it('never names a diagnosis', () => {
		expect(EVERY.filter((s) => DIAGNOSIS.test(s))).toEqual([]);
	});

	it('points a lasting problem to Profile → Injuries, and sharp or persisting pain to a professional', () => {
		expect(copy.PAIN_COPY.injuries.link).toBe('Add it to Profile → Injuries');
		expect(copy.PAIN_COPY.injuries.text).toMatch(/keeps coming back/);
		expect(copy.PAIN_COPY.injuries.text).toMatch(/plan works around it/);
		expect(copy.PAIN_COPY.professional).toMatch(/sharp/);
		expect(copy.PAIN_COPY.professional).toMatch(/persists/);
		expect(copy.PAIN_COPY.professional).toMatch(/doctor|physiotherapist/);
		expect(PAIN).toContain(copy.PAIN_COPY.professional);
	});

	it('offers Stop first in words as in the rules, and names End the workout here', () => {
		expect(copy.PAIN_COPY.stop.label).toBe('Stop this exercise');
		expect(copy.PAIN_COPY.end.label).toBe('End the workout here');
		expect(PAIN.some((s) => s.startsWith('Stop'))).toBe(true);
	});

	it('words every quick action and every slot state', () => {
		expect(Object.keys(copy.QUICK_ACTION_COPY)).toEqual(Object.keys(QUICK_ACTIONS));
		expect(copy.QUICK_ACTION_COPY.machine_unavailable.label).toBe('Machine unavailable');
		expect(copy.QUICK_ACTION_COPY.dislike.label).toBe("I don't like this exercise");
		expect(copy.QUICK_ACTION_COPY.pain.label).toBe('This hurts');
		expect(copy.SLOT_STATE_COPY).toEqual({
			planned: null,
			added: 'Added',
			swapped: 'Swapped for this session',
			wont_prescribe: "Won't be prescribed again",
			skipped: 'Skipped',
			stopped: 'Stopped'
		});
	});

	it('asks before a dislike, saying what changes today and in the plan', () => {
		const names = { exercise: 'Leg press', replacement: 'Hack squat' };
		expect(copy.dislikeConfirmation(names, true)).toEqual({
			title: "Don't prescribe Leg press again?",
			body: "Today you'll do Hack squat, and your plan uses it from today. You can change this in Profile → Exercises.",
			confirm: "Don't prescribe it again",
			cancel: 'Cancel'
		});
		expect(copy.dislikeConfirmation(names, false).body).toBe(
			"Today you'll do Hack squat. You can change this in Profile → Exercises."
		);
	});

	it('says what each alternative needs', () => {
		expect(copy.needsLine([])).toBe('No equipment needed');
		expect(copy.needsLine(['dumbbells', 'bench'])).toBe('Needs Dumbbells, Bench');
	});
});
