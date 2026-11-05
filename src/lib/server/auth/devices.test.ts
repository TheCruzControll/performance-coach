import { describe, expect, it } from 'vitest';
import { defaultPasskeyName, describeUserAgent, passkeyProvider } from './devices';

const UA = {
	iphoneSafari:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
	iphoneChrome:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1',
	macChrome:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
	macSafari:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
	windowsEdge:
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
	linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'
};

describe('device labels', () => {
	it('summarise a User-Agent as "<browser> on <device>"', () => {
		expect(describeUserAgent(UA.iphoneSafari)).toBe('Safari on iPhone');
		expect(describeUserAgent(UA.iphoneChrome)).toBe('Chrome on iPhone');
		expect(describeUserAgent(UA.macChrome)).toBe('Chrome on Mac');
		expect(describeUserAgent(UA.macSafari)).toBe('Safari on Mac');
		expect(describeUserAgent(UA.windowsEdge)).toBe('Edge on Windows');
		expect(describeUserAgent(UA.linuxFirefox)).toBe('Firefox on Linux');
		expect(describeUserAgent(null)).toBe('Unknown device');
		expect(describeUserAgent('curl/8.0')).toBe('Unknown device');
	});

	it('name passkeys by provider when the AAGUID is well known', () => {
		expect(passkeyProvider('FBFC3007-154E-4ECC-8C0B-6E020557D7BD')).toBe('iCloud Keychain');
		expect(passkeyProvider('00000000-0000-0000-0000-000000000000')).toBeNull();
		expect(defaultPasskeyName('fbfc3007-154e-4ecc-8c0b-6e020557d7bd', UA.iphoneSafari)).toBe(
			'iPhone · iCloud Keychain'
		);
		expect(defaultPasskeyName('00000000-0000-0000-0000-000000000000', UA.macChrome)).toBe(
			'Mac passkey'
		);
		expect(defaultPasskeyName(null, null)).toBe('Passkey');
	});
});
