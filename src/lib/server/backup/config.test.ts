import { createHash, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	backupConfig,
	backupLogFields,
	cronConfig,
	cronSecretProblem,
	MIN_CRON_SECRET_LENGTH,
	type BackupEnv
} from './config.ts';
import { parseBackupKey } from './key.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const KEY_URL = Buffer.alloc(32, 7).toString('base64url');
const TOKEN = 'vercel_blob_rw_AbC123storeId_s3cretPartOfTheToken';
const DIR = 'test-results/backups';
const SECRET = 'c'.repeat(MIN_CRON_SECRET_LENGTH);

const off = (missing: string[], invalid: string[] = []) => ({ state: 'off', missing, invalid });

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('backupConfig: on', () => {
	it('uses the Blob store with a valid key and token', () => {
		const config = backupConfig({ BACKUP_ENCRYPTION_KEY: KEY, BLOB_READ_WRITE_TOKEN: TOKEN });
		expect(config).toMatchObject({ state: 'on', store: { kind: 'blob', token: TOKEN } });
		expect(config.state === 'on' && config.key.id).toBe(
			parseBackupKey(KEY, 'BACKUP_ENCRYPTION_KEY').id
		);
	});

	it('accepts the key in base64url too', () => {
		expect(backupConfig({ BACKUP_ENCRYPTION_KEY: KEY_URL, BACKUP_DIR: DIR })).toMatchObject({
			state: 'on',
			store: { kind: 'file', dir: DIR }
		});
	});

	it('uses BACKUP_DIR off Vercel when no Blob token is set', () => {
		expect(backupConfig({ BACKUP_ENCRYPTION_KEY: KEY, BACKUP_DIR: DIR })).toMatchObject({
			state: 'on',
			store: { kind: 'file', dir: DIR }
		});
	});

	it('prefers the Blob token over BACKUP_DIR, on Vercel or not', () => {
		for (const vercel of [{}, { VERCEL: true, VERCEL_ENV: 'production' }]) {
			expect(
				backupConfig({
					...vercel,
					BACKUP_ENCRYPTION_KEY: KEY,
					BLOB_READ_WRITE_TOKEN: TOKEN,
					BACKUP_DIR: DIR
				})
			).toMatchObject({ state: 'on', store: { kind: 'blob', token: TOKEN } });
		}
	});
});

describe('backupConfig: missing and invalid variables switch backups off and are named', () => {
	it('names every missing variable when nothing is set', () => {
		expect(backupConfig({})).toEqual(off(['BACKUP_ENCRYPTION_KEY', 'BLOB_READ_WRITE_TOKEN']));
	});

	it('names the missing key, or the missing store, alone', () => {
		expect(backupConfig({ BLOB_READ_WRITE_TOKEN: TOKEN })).toEqual(off(['BACKUP_ENCRYPTION_KEY']));
		expect(backupConfig({ BACKUP_DIR: DIR })).toEqual(off(['BACKUP_ENCRYPTION_KEY']));
		expect(backupConfig({ BACKUP_ENCRYPTION_KEY: KEY })).toEqual(off(['BLOB_READ_WRITE_TOKEN']));
	});

	it('refuses a key that is not 32 bytes of canonical base64 or base64url', () => {
		for (const bad of [
			Buffer.alloc(31, 7).toString('base64'),
			Buffer.alloc(33, 7).toString('base64'),
			'not base64 at all!',
			KEY.slice(0, -2) + 'x=',
			'k'.repeat(10_000)
		]) {
			expect(
				backupConfig({ BACKUP_ENCRYPTION_KEY: bad, BLOB_READ_WRITE_TOKEN: TOKEN }),
				bad
			).toEqual(off([], ['BACKUP_ENCRYPTION_KEY']));
		}
	});

	it('refuses a Blob token that is not a read-write token, and never falls back to BACKUP_DIR', () => {
		for (const bad of [
			'vercel_blob_ro_AbC123_secret',
			'vercel_blob_rw_',
			'vercel_blob_rw_store_',
			'vercel_blob_rw_store_sec ret',
			'sk_live_somethingElse',
			`${TOKEN}\nsecond line`
		]) {
			expect(
				backupConfig({ BACKUP_ENCRYPTION_KEY: KEY, BLOB_READ_WRITE_TOKEN: bad, BACKUP_DIR: DIR }),
				bad
			).toEqual(off([], ['BLOB_READ_WRITE_TOKEN']));
		}
	});

	it('refuses BACKUP_DIR on Vercel (VERCEL=1 or any VERCEL_ENV)', () => {
		for (const vercel of [
			{ VERCEL: true },
			{ VERCEL_ENV: 'production' },
			{ VERCEL_ENV: 'preview' },
			{ VERCEL_ENV: 'development' }
		]) {
			expect(backupConfig({ ...vercel, BACKUP_ENCRYPTION_KEY: KEY, BACKUP_DIR: DIR })).toEqual(
				off([], ['BACKUP_DIR'])
			);
		}
	});

	it('refuses BACKUP_DIR in a server built for Vercel, whatever the runtime says', () => {
		vi.stubGlobal('__VERCEL_BUILD__', true);
		expect(backupConfig({ BACKUP_ENCRYPTION_KEY: KEY, BACKUP_DIR: DIR })).toEqual(
			off([], ['BACKUP_DIR'])
		);
	});

	it('refuses a BACKUP_DIR holding NUL or a line break', () => {
		for (const bad of ['a\0b', 'a\nb', 'a\rb']) {
			expect(backupConfig({ BACKUP_ENCRYPTION_KEY: KEY, BACKUP_DIR: bad })).toEqual(
				off([], ['BACKUP_DIR'])
			);
		}
	});

	it('reports a missing variable and an invalid one together', () => {
		expect(backupConfig({ BACKUP_ENCRYPTION_KEY: 'short' })).toEqual(
			off(['BLOB_READ_WRITE_TOKEN'], ['BACKUP_ENCRYPTION_KEY'])
		);
		expect(backupConfig({ VERCEL: true, BACKUP_ENCRYPTION_KEY: 'short', BACKUP_DIR: DIR })).toEqual(
			off([], ['BACKUP_ENCRYPTION_KEY', 'BACKUP_DIR'])
		);
		expect(backupConfig({ BACKUP_ENCRYPTION_KEY: 'short', BLOB_READ_WRITE_TOKEN: 'x' })).toEqual(
			off([], ['BACKUP_ENCRYPTION_KEY', 'BLOB_READ_WRITE_TOKEN'])
		);
	});
});

describe('cronConfig', () => {
	it('is null, and the secret missing, while CRON_SECRET is unset', () => {
		expect(cronConfig({})).toBeNull();
		expect(cronSecretProblem({})).toBe('missing');
	});

	it(`needs at least ${MIN_CRON_SECRET_LENGTH} characters: 31 is invalid, 32 is enough`, () => {
		expect(MIN_CRON_SECRET_LENGTH).toBe(32);
		const short = 's'.repeat(31);
		expect(cronConfig({ CRON_SECRET: short })).toBeNull();
		expect(cronSecretProblem({ CRON_SECRET: short })).toBe('invalid');
		expect(cronSecretProblem({ CRON_SECRET: SECRET })).toBeNull();
	});

	it('refuses a secret that is not one header-safe token', () => {
		for (const bad of [`${SECRET} x`, `${SECRET}\n`, `${SECRET}é`, `${SECRET}\u0000`]) {
			expect(cronConfig({ CRON_SECRET: bad }), JSON.stringify(bad)).toBeNull();
			expect(cronSecretProblem({ CRON_SECRET: bad })).toBe('invalid');
		}
	});

	it('holds only the SHA-256 digest of the secret', () => {
		const secret = randomBytes(32).toString('base64');
		const config = cronConfig({ CRON_SECRET: secret });
		expect(config).toEqual({ secretDigest: createHash('sha256').update(secret).digest() });
		expect(Object.keys(config!)).toEqual(['secretDigest']);
	});

	it('is independent of the backup variables', () => {
		expect(cronConfig({ CRON_SECRET: SECRET })).not.toBeNull();
		expect(backupConfig({ CRON_SECRET: SECRET }).state).toBe('off');
	});
});

describe('backupLogFields (the startup line)', () => {
	it('names the store when backups and the cron are on', () => {
		expect(
			backupLogFields({
				CRON_SECRET: SECRET,
				BACKUP_ENCRYPTION_KEY: KEY,
				BLOB_READ_WRITE_TOKEN: TOKEN
			})
		).toEqual({ backups: 'blob', backupCron: 'on' });
		expect(
			backupLogFields({ CRON_SECRET: SECRET, BACKUP_ENCRYPTION_KEY: KEY, BACKUP_DIR: DIR })
		).toEqual({ backups: 'file', backupCron: 'on' });
	});

	it('names what is missing or invalid', () => {
		expect(backupLogFields({})).toEqual({
			backups: 'off',
			backupsMissing: ['BACKUP_ENCRYPTION_KEY', 'BLOB_READ_WRITE_TOKEN'],
			backupsInvalid: [],
			backupCron: 'off',
			backupCronMissing: ['CRON_SECRET']
		});
		expect(
			backupLogFields({
				CRON_SECRET: 'short',
				BACKUP_ENCRYPTION_KEY: 'short',
				VERCEL: true,
				BACKUP_DIR: DIR
			})
		).toEqual({
			backups: 'off',
			backupsMissing: [],
			backupsInvalid: ['BACKUP_ENCRYPTION_KEY', 'BACKUP_DIR'],
			backupCron: 'off',
			backupCronInvalid: ['CRON_SECRET']
		});
	});
});

describe('no value is ever shown', () => {
	const SENTINEL = 'SENTINELq7Zk';
	/** Every way a value could leak: JSON, inspection, string forms, error messages. */
	const shown = (value: unknown) =>
		[JSON.stringify(value), inspect(value, { depth: 10, showHidden: true }), String(value)].join(
			'\n'
		);

	it('in the config, the startup line or any error, valid or not', () => {
		const validKey = randomBytes(32);
		const validSecret = `${SENTINEL}${randomBytes(24).toString('base64url')}`;
		const cases: BackupEnv[] = [
			// Invalid values that carry the sentinel.
			{
				CRON_SECRET: SENTINEL,
				BACKUP_ENCRYPTION_KEY: `${SENTINEL}notakey`,
				BLOB_READ_WRITE_TOKEN: `vercel_blob_ro_${SENTINEL}_x`,
				BACKUP_DIR: `/tmp/${SENTINEL}`
			},
			{ VERCEL: true, BACKUP_ENCRYPTION_KEY: `${SENTINEL}=`, BACKUP_DIR: `/tmp/${SENTINEL}` },
			// Valid ones: the key and the secret never appear, in either encoding.
			{
				CRON_SECRET: validSecret,
				BACKUP_ENCRYPTION_KEY: validKey.toString('base64'),
				BLOB_READ_WRITE_TOKEN: `vercel_blob_rw_store_${SENTINEL}`
			},
			{
				CRON_SECRET: validSecret,
				BACKUP_ENCRYPTION_KEY: validKey.toString('base64url'),
				BACKUP_DIR: DIR
			}
		];
		const secrets = [
			SENTINEL,
			validKey.toString('base64'),
			validKey.toString('base64url'),
			validKey.toString('hex'),
			createHash('sha256').update(validSecret).digest('hex')
		];
		for (const env of cases) {
			const line = shown(backupLogFields(env));
			for (const secret of secrets) expect(line).not.toContain(secret);

			const config = backupConfig(env);
			const printable = config.state === 'on' ? { ...config, store: config.store.kind } : config;
			for (const secret of secrets) expect(shown(printable)).not.toContain(secret);
			if (config.state === 'on') {
				for (const secret of secrets) expect(shown(config.key)).not.toContain(secret);
			}
			for (const secret of secrets) expect(shown(cronConfig(env))).not.toContain(secret);
		}
	});

	it('even for a value that would make the key parser throw something else', () => {
		// parseBackupKey's own refusal names the variable and a length, never the text.
		expect(() => parseBackupKey(`${SENTINEL}`, 'BACKUP_ENCRYPTION_KEY')).toThrow(
			/^BACKUP_ENCRYPTION_KEY must be 32 bytes/
		);
		try {
			parseBackupKey(`${SENTINEL}`, 'BACKUP_ENCRYPTION_KEY');
		} catch (error) {
			expect(shown(error)).not.toContain(SENTINEL);
		}
	});
});
