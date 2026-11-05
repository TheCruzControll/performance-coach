/**
 * Human labels for sessions and passkeys (pure): "Safari on iPhone", "iCloud Keychain".
 * Only used for display and default nicknames; never for any security decision.
 */

/** Well-known passkey provider AAGUIDs (community list: passkeydeveloper/passkey-authenticator-aaguids). */
const PROVIDERS: Record<string, string> = {
	'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
	'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain',
	'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
	'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
	'08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
	'9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
	'6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
	'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
	'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden'
};

export function passkeyProvider(aaguid: string | null | undefined): string | null {
	return (aaguid && PROVIDERS[aaguid.toLowerCase()]) || null;
}

function device(ua: string): string | null {
	if (/iPhone/.test(ua)) return 'iPhone';
	if (/iPad/.test(ua)) return 'iPad';
	if (/Android/.test(ua)) return 'Android';
	if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
	if (/Windows/.test(ua)) return 'Windows';
	if (/CrOS/.test(ua)) return 'Chromebook';
	if (/Linux/.test(ua)) return 'Linux';
	return null;
}

function browser(ua: string): string | null {
	if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge';
	if (/Firefox|FxiOS/.test(ua)) return 'Firefox';
	if (/CriOS|Chrome\//.test(ua)) return 'Chrome';
	if (/Safari\//.test(ua) || /AppleWebKit/.test(ua)) return 'Safari';
	return null;
}

/** "Safari on iPhone", "Chrome on Mac", or "Unknown device". At most 64 characters. */
export function describeUserAgent(ua: string | null | undefined): string {
	if (!ua) return 'Unknown device';
	const d = device(ua);
	const b = browser(ua);
	if (d && b) return `${b} on ${d}`;
	return (d ?? b ?? 'Unknown device').slice(0, 64);
}

/** Default nickname for a newly added passkey: its provider, else the device it was made on. */
export function defaultPasskeyName(aaguid: string | null | undefined, ua: string | null): string {
	const provider = passkeyProvider(aaguid);
	const d = ua ? device(ua) : null;
	if (provider && d) return `${d} · ${provider}`;
	return provider ?? (d ? `${d} passkey` : 'Passkey');
}
