import { describe, expect, it } from 'vitest';
import { DEFAULT_RETURN_PATH, safeReturnPath, signInUrl } from './return-path';

describe('safe return path', () => {
	it('keeps same-origin app paths with their query and hash', () => {
		expect(safeReturnPath('/profile')).toBe('/profile');
		expect(safeReturnPath('/train?tool=plates#x')).toBe('/train?tool=plates#x');
		expect(safeReturnPath('/profile/security')).toBe('/profile/security');
	});

	it('falls back for anything that could leave the site', () => {
		for (const bad of [
			null,
			undefined,
			'',
			'today',
			'//evil.example',
			'/\\evil.example',
			'\\\\evil.example',
			'https://evil.example/',
			'javascript:alert(1)',
			'/%0d%0aSet-Cookie:x',
			'/\u0000',
			'/ok\nLocation: //evil',
			`/${'a'.repeat(600)}`
		]) {
			expect(safeReturnPath(bad as string), String(bad)).toBe(DEFAULT_RETURN_PATH);
		}
	});

	it('never returns into the auth flow or an endpoint', () => {
		for (const path of [
			'/',
			'/setup?token=x',
			'/recover',
			'/recover/passkey',
			'/api/vitals',
			'/today/__data.json'
		]) {
			expect(safeReturnPath(path), path).toBe(DEFAULT_RETURN_PATH);
		}
	});

	it('builds the sign-in redirect for a denied page', () => {
		expect(signInUrl('/profile')).toBe('/?next=%2Fprofile');
		expect(signInUrl('/train?tool=plates')).toBe('/?next=%2Ftrain%3Ftool%3Dplates');
		expect(signInUrl('//evil.example')).toBe('/');
		expect(signInUrl('/api/vitals')).toBe('/');
	});
});
