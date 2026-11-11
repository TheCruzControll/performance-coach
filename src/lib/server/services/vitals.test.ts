import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROUTE_ACCESS } from '../auth/routes';
import { START_METRICS, START_ROUTE_ID } from './vitals';

const manifest = JSON.parse(
	readFileSync(new URL('../../../../static/manifest.webmanifest', import.meta.url), 'utf8')
) as { start_url: string };

describe('the start route', () => {
	it("is the route the manifest's start_url opens", () => {
		// A route id names its groups; the URL does not: /(app)/today serves /today.
		const path = START_ROUTE_ID.replace(/\/\([^)]+\)/g, '') || '/';
		expect(path).toBe(new URL(manifest.start_url, 'https://coach.example').pathname);
		expect(Object.keys(ROUTE_ACCESS)).toContain(START_ROUTE_ID);
	});

	it('is judged by TTFB, LCP and INP', () => {
		expect([...START_METRICS]).toEqual(['TTFB', 'LCP', 'INP']);
	});
});
