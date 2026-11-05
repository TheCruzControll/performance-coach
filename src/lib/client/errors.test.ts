import { describe, expect, it } from 'vitest';
import { toReport } from './errors';

const where = { path: '/train', route: '/(app)/train', version: '0.1.0+abc1234' };

describe('client error reports', () => {
	it('captures name, message, stack and where it happened', () => {
		const error = new TypeError('cannot read properties of undefined');
		expect(toReport(error, 'error', where)).toEqual({
			source: 'error',
			name: 'TypeError',
			message: 'cannot read properties of undefined',
			stack: error.stack,
			path: '/train',
			route: '/(app)/train',
			version: '0.1.0+abc1234'
		});
	});

	it('handles values that are not errors', () => {
		expect(toReport('plain string', 'unhandledrejection', where)).toMatchObject({
			name: 'NonError',
			message: 'plain string'
		});
		expect(toReport({ code: 42 }, 'unhandledrejection', where)?.message).toBe('{"code":42}');
		expect(toReport(undefined, 'unhandledrejection', where)).toBeNull();
	});

	it('bounds every field to what the endpoint accepts', () => {
		const error = new Error('x'.repeat(5_000));
		error.stack = 'y'.repeat(20_000);
		const report = toReport(error, 'handleError', { ...where, path: `/${'p'.repeat(600)}` })!;
		expect(report.message).toHaveLength(1_000);
		expect(report.stack).toHaveLength(8_000);
		expect(report.path).toHaveLength(512);
	});
});
