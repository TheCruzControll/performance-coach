import { describe, expect, it } from 'vitest';
import { syncWords } from './sync-words';

describe('syncWords', () => {
	it('says every status in words, with an icon', () => {
		expect(
			[
				{ state: 'synced' },
				{ state: 'saving', pending: 2 },
				{ state: 'offline', pending: 3 },
				{ state: 'retrying', seconds: 4, pending: 1 },
				{ state: 'retrying', seconds: 0, pending: 1 },
				{ state: 'attention', count: 1 },
				{ state: 'attention', count: 2 },
				{ state: 'signed-out', waiting: 2 },
				{ state: 'passkey', waiting: 2 }
			].map((status) => {
				const { icon, text } = syncWords(status as never);
				return `${icon}: ${text}`;
			})
		).toEqual([
			'check: Saved',
			'refresh: Saving…',
			'wifi-off: Offline · 3 pending',
			'clock: Retrying in 4 s',
			'clock: Retrying in 1 s',
			'alert: 1 needs attention',
			'alert: 2 need attention',
			'lock: Sign in to sync · 2 waiting',
			'passkey: Finish adding your passkey'
		]);
	});

	it('says no count past 999, so the longest words stay the reserved ones', () => {
		expect(
			[999, 1000, 25_000].map((n) => [
				syncWords({ state: 'signed-out', waiting: n }).text,
				syncWords({ state: 'offline', pending: n }).text,
				syncWords({ state: 'attention', count: n }).text
			])
		).toEqual([
			['Sign in to sync · 999 waiting', 'Offline · 999 pending', '999 need attention'],
			['Sign in to sync · 999+ waiting', 'Offline · 999+ pending', '999+ need attention'],
			['Sign in to sync · 999+ waiting', 'Offline · 999+ pending', '999+ need attention']
		]);
	});
});
