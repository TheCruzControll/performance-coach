/**
 * The generator's public entry point (index.ts): what services and the M5 coach's tools call, the
 * modules' own functions and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { alternativesFor } from './alternatives';
import { GeneratedPlanError, generateProgram } from './generate';
import * as programming from './index';
import { buildProgrammingInput } from './input';
import { checkWeek } from './interference';
import { catalogueDigest, fingerprint, GENERATOR_ID } from './random';

describe('domain/programming/index.ts', () => {
	it('exports the generator, its input, the fingerprint and the checks, each the module’s own', () => {
		expect({ ...programming }).toEqual({
			generateProgram,
			GeneratedPlanError,
			buildProgrammingInput,
			fingerprint,
			catalogueDigest,
			GENERATOR_ID,
			checkWeek,
			alternativesFor
		});
		expect(programming.generateProgram).toBe(generateProgram);
		expect(programming.checkWeek).toBe(checkWeek);
	});
});
