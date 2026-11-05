/**
 * A software WebAuthn authenticator for integration tests (test code only; the app never
 * implements any part of the protocol itself). It produces *real* registration and assertion
 * responses — ES256 keys from node:crypto, CBOR via SimpleWebAuthn's own helper — so the
 * services are exercised through @simplewebauthn/server's genuine verification, including
 * origin, RP ID, challenge, user-verification and signature-counter checks.
 */
import {
	createHash,
	createSign,
	generateKeyPairSync,
	randomBytes,
	type KeyObject
} from 'node:crypto';
import type {
	AuthenticationResponseJSON,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON
} from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array | Buffer | string) => createHash('sha256').update(data).digest();

export interface CeremonyOverrides {
	origin?: string;
	rpId?: string;
	challenge?: string;
	userVerified?: boolean;
	type?: string;
	/** Force the signature counter reported by this assertion. */
	counter?: number;
}

export class SoftAuthenticator {
	readonly credentialId = randomBytes(32);
	readonly aaguid = Buffer.alloc(16); // "none" attestation: zero AAGUID
	#privateKey: KeyObject;
	#publicKey: KeyObject;
	#userHandle: string | undefined;
	counter: number;

	constructor(
		readonly rp: { rpId: string; origin: string },
		options: { counter?: number; synced?: boolean } = {}
	) {
		const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
		this.#privateKey = privateKey;
		this.#publicKey = publicKey;
		this.counter = options.counter ?? 0;
		this.synced = options.synced ?? true;
	}

	synced: boolean;

	get id(): string {
		return b64url(this.credentialId);
	}

	#coseKey(): Uint8Array {
		const jwk = this.#publicKey.export({ format: 'jwk' });
		return isoCBOR.encode(
			new Map<number, number | Uint8Array>([
				[1, 2], // kty: EC2
				[3, -7], // alg: ES256
				[-1, 1], // crv: P-256
				[-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
				[-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))]
			])
		);
	}

	#authData(rpId: string, flags: number, counter: number, attested: boolean): Buffer {
		const count = Buffer.alloc(4);
		count.writeUInt32BE(counter);
		const parts = [sha256(rpId), Buffer.from([flags]), count];
		if (attested) {
			const idLength = Buffer.alloc(2);
			idLength.writeUInt16BE(this.credentialId.length);
			parts.push(this.aaguid, idLength, this.credentialId, Buffer.from(this.#coseKey()));
		}
		return Buffer.concat(parts);
	}

	#flags(userVerified: boolean, attested: boolean): number {
		return (
			FLAG_UP |
			(userVerified ? FLAG_UV : 0) |
			(this.synced ? FLAG_BE | FLAG_BS : 0) |
			(attested ? FLAG_AT : 0)
		);
	}

	#clientData(type: string, challenge: string, origin: string): Buffer {
		return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
	}

	/** Answer `navigator.credentials.create()` for these options. */
	register(
		options: PublicKeyCredentialCreationOptionsJSON,
		overrides: CeremonyOverrides = {}
	): RegistrationResponseJSON {
		this.#userHandle = options.user.id;
		const rpId = overrides.rpId ?? options.rp.id ?? this.rp.rpId;
		const clientDataJSON = this.#clientData(
			overrides.type ?? 'webauthn.create',
			overrides.challenge ?? options.challenge,
			overrides.origin ?? this.rp.origin
		);
		const authData = this.#authData(
			rpId,
			this.#flags(overrides.userVerified ?? true, true),
			this.counter,
			true
		);
		const attestationObject = isoCBOR.encode(
			new Map<string, unknown>([
				['fmt', 'none'],
				['attStmt', new Map()],
				['authData', new Uint8Array(authData)]
			]) as never
		);
		return {
			id: this.id,
			rawId: this.id,
			type: 'public-key',
			response: {
				clientDataJSON: b64url(clientDataJSON),
				attestationObject: b64url(attestationObject),
				transports: ['internal', 'hybrid']
			},
			clientExtensionResults: {},
			authenticatorAttachment: 'platform'
		};
	}

	/** Answer `navigator.credentials.get()` for these options (discoverable: returns userHandle). */
	assert(
		options: PublicKeyCredentialRequestOptionsJSON,
		overrides: CeremonyOverrides = {}
	): AuthenticationResponseJSON {
		if (overrides.counter === undefined && this.counter > 0) this.counter += 1;
		const counter = overrides.counter ?? this.counter;
		const rpId = overrides.rpId ?? options.rpId ?? this.rp.rpId;
		const clientDataJSON = this.#clientData(
			overrides.type ?? 'webauthn.get',
			overrides.challenge ?? options.challenge,
			overrides.origin ?? this.rp.origin
		);
		const authData = this.#authData(
			rpId,
			this.#flags(overrides.userVerified ?? true, false),
			counter,
			false
		);
		const signature = createSign('SHA256')
			.update(Buffer.concat([authData, sha256(clientDataJSON)]))
			.sign(this.#privateKey);
		return {
			id: this.id,
			rawId: this.id,
			type: 'public-key',
			response: {
				clientDataJSON: b64url(clientDataJSON),
				authenticatorData: b64url(authData),
				signature: b64url(signature),
				...(this.#userHandle ? { userHandle: this.#userHandle } : {})
			},
			clientExtensionResults: {},
			authenticatorAttachment: 'platform'
		};
	}
}
