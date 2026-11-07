/**
 * The sync status in words, with an icon, never by colour alone (the offline workout sync ADR):
 * what the workout header's pill says for each OutboxStatus. Change the words here.
 */
import type { OutboxStatus } from '#lib/client/workout/outbox-rules.ts';
import type { IconName } from '../icons/icons.ts';

export interface SyncWords {
	icon: IconName;
	text: string;
	/** Needs the owner: a refusal, a stuck change, a lost session. */
	alert: boolean;
}

export function syncWords(status: OutboxStatus): SyncWords {
	const words = (icon: IconName, text: string, alert = false) => ({ icon, text, alert });
	switch (status.state) {
		case 'synced':
			return words('check', 'Saved');
		case 'saving':
			return words('refresh', 'Saving…');
		case 'offline':
			return words('wifi-off', `Offline · ${status.pending} pending`);
		case 'retrying':
			return words('clock', `Retrying in ${Math.max(1, status.seconds)} s`);
		case 'attention':
			return words(
				'alert',
				`${status.count} ${status.count === 1 ? 'needs' : 'need'} attention`,
				true
			);
		case 'signed-out':
			return words('lock', `Sign in to sync · ${status.waiting} waiting`, true);
		case 'passkey':
			return words('passkey', 'Finish adding your passkey', true);
	}
}
