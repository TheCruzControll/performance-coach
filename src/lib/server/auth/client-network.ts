/**
 * The network a per-client rate limit counts against (pure; docs/security.md, rate limits).
 */
import { isIPv4, isIPv6 } from 'node:net';

/**
 * IPv4 counts per address. IPv6 counts per /64: one host or LAN normally holds a whole /64
 * (SLAAC, privacy addresses), so keying on the full address would hand it fresh buckets at
 * will. IPv4-mapped IPv6 (`::ffff:203.0.113.7`, how a dual-stack socket reports an IPv4 peer)
 * is that IPv4 address. Anything else is returned unchanged.
 */
export function clientNetwork(address: string): string {
	if (isIPv4(address)) return address;
	// A zone id (`fe80::1%en0`) names the server's interface, not the client.
	const ip = address.replace(/%.*$/, '');
	if (!isIPv6(ip)) return address;
	const groups = hextets(ip);
	if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
		return groups
			.slice(6)
			.flatMap((g) => [g >> 8, g & 0xff])
			.join('.');
	}
	return `${groups
		.slice(0, 4)
		.map((g) => g.toString(16))
		.join(':')}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address. */
function hextets(ip: string): number[] {
	// The URL host parser canonicalises it: lowercase, an embedded IPv4 tail as two groups,
	// at most one `::`.
	const canonical = new URL(`http://[${ip}]`).hostname.slice(1, -1);
	const [head = '', tail = ''] = canonical.split('::');
	const left = head ? head.split(':') : [];
	const right = tail ? tail.split(':') : [];
	const zeros = Array<string>(8 - left.length - right.length).fill('0');
	return [...left, ...zeros, ...right].map((g) => parseInt(g, 16));
}
