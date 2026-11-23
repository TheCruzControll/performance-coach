import { describe, expect, it } from 'vitest';
import { AuthError } from './errors';
import { parseRegistrationResponse } from './webauthn';

/** A registration response whose attestationObject is `length` base64url characters long. */
function registration(length: number) {
	return {
		id: 'AAAA',
		rawId: 'AAAA',
		type: 'public-key',
		response: { clientDataJSON: 'AAAA', attestationObject: 'A'.repeat(length) },
		clientExtensionResults: {}
	};
}

describe('parseRegistrationResponse', () => {
	it('takes an attestationObject up to 8192 characters, so a registration fits the 16 KB public cap', () => {
		expect(() => parseRegistrationResponse(registration(8192))).not.toThrow();
	});

	it('refuses an attestationObject one character longer', () => {
		expect(() => parseRegistrationResponse(registration(8193))).toThrow(AuthError);
	});
});
