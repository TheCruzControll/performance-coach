import { describe, expect, it } from 'vitest';
import { clientNetwork } from './client-network';

describe('client network (rate-limit key)', () => {
	it('keeps an IPv4 address whole', () => {
		expect(clientNetwork('203.0.113.7')).toBe('203.0.113.7');
		expect(clientNetwork('127.0.0.1')).toBe('127.0.0.1');
	});

	it('cuts IPv6 to its /64, however the address is spelled', () => {
		for (const ip of [
			'2001:db8:1:2::1',
			'2001:db8:1:2:a:b:c:d',
			'2001:DB8:1:2:FFFF:FFFF:FFFF:FFFF',
			'2001:0db8:0001:0002:0000:0000:0000:0001',
			'2001:db8:1:2::203.0.113.7'
		]) {
			expect(clientNetwork(ip), ip).toBe('2001:db8:1:2::/64');
		}
		expect(clientNetwork('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
		expect(clientNetwork('2001:db8::1')).toBe('2001:db8:0:0::/64');
		expect(clientNetwork('2001:db8:0:0:1::')).toBe('2001:db8:0:0::/64');
		expect(clientNetwork('::1')).toBe('0:0:0:0::/64');
		expect(clientNetwork('::')).toBe('0:0:0:0::/64');
		expect(clientNetwork('fe80::1%en0')).toBe('fe80:0:0:0::/64');
	});

	it('counts IPv4-mapped IPv6 as the IPv4 address', () => {
		expect(clientNetwork('::ffff:203.0.113.7')).toBe('203.0.113.7');
		expect(clientNetwork('::FFFF:203.0.113.7')).toBe('203.0.113.7');
		expect(clientNetwork('::ffff:cb00:7107')).toBe('203.0.113.7');
		expect(clientNetwork('0:0:0:0:0:ffff:7f00:1')).toBe('127.0.0.1');
		// Only the ::ffff:0:0/96 prefix is mapped; other IPv6 with an IPv4 tail stays IPv6.
		expect(clientNetwork('64:ff9b::203.0.113.7')).toBe('64:ff9b:0:0::/64');
	});

	it('returns anything that is not an IP address unchanged', () => {
		for (const value of ['unknown', '', 'not an ip', '203.0.113.256', '2001:db8::1::2', '[::1]']) {
			expect(clientNetwork(value), value).toBe(value);
		}
	});
});
