import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { BODY_AREAS, EQUIPMENT } from '../profile/catalog';
import * as copy from '../workout/copy';
import source from '../workout/copy.ts?raw';
import { scanAdvice } from './safety';

/**
 * M4's in-workout copy, scanned with the coach's own rules: every string domain/workout/copy.ts
 * writes or renders passes scanAdvice in pain context, the strictest reading (the pain flow is
 * pain context, and the coach repeats this wording in its safety blocks).
 */

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

/** Arguments each exported function is rendered with, so each of its branches is scanned. */
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
		if (!samples) throw new Error(`copy-scan.test.ts has no sample arguments for ${path}`);
		return samples.flatMap((args) => rendered(value(...args), `${path}()`));
	}
	if (value && typeof value === 'object') {
		return Object.entries(value).flatMap(([key, v]) => rendered(v, path ? `${path}.${key}` : key));
	}
	return [];
}

describe("M4's workout copy under the coach's rules", () => {
	const strings = [...literals(source), ...rendered(copy, '')];

	it('scans something real', () => {
		expect(strings.length).toBeGreaterThan(80);
		expect(strings).toContain(copy.PAIN_COPY.professional);
		expect(strings).toContain(copy.noGentler('knee'));
	});

	it('every string it writes or renders passes scanAdvice in pain context', () => {
		const flagged = strings
			.map((text) => ({ text, violations: scanAdvice(text, { painContext: true }) }))
			.filter((s) => s.violations.length > 0);
		expect(flagged).toEqual([]);
	});

	it('would catch a banned line added to it', () => {
		for (const line of [
			'Push through it',
			'Keep going!',
			'It might be a strain',
			`${copy.PAIN_COPY.intro} Tough it out.`
		]) {
			expect(scanAdvice(line, { painContext: true }).length, line).toBeGreaterThan(0);
		}
	});
});
