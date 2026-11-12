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
	/**
	 * All is well (Saved): said as quiet text with its check, with no pill around it, so the
	 * header shows no empty field the width of the longest words.
	 */
	quiet?: true;
}

/** A count as the pill says it: past 999, "999+", so the reserved width holds every count. */
const upTo999 = (n: number) => (n > 999 ? '999+' : `${n}`);

export function syncWords(status: OutboxStatus): SyncWords {
	const words = (icon: IconName, text: string, alert = false) => ({ icon, text, alert });
	switch (status.state) {
		case 'synced':
			return { icon: 'check', text: 'Saved', alert: false, quiet: true };
		case 'saving':
			return words('refresh', 'Saving…');
		case 'offline':
			return words('wifi-off', `Offline · ${upTo999(status.pending)} pending`);
		// Online, but the server does not answer (dead gym Wi-Fi, a captive portal): it keeps trying.
		// Not 'Can’t reach the server', as elsewhere: the pill's box is its widest words, and those
		// (16.6 em to 13.1 em) would drop it under Minimise on a phone in every state.
		case 'unreachable':
			return words('wifi-off', `Can’t connect · ${upTo999(status.waiting)} waiting`);
		case 'retrying':
			return words('clock', `Retrying in ${Math.max(1, status.seconds)} s`);
		case 'attention':
			return words(
				'alert',
				`${upTo999(status.count)} ${status.count === 1 ? 'needs' : 'need'} attention`,
				true
			);
		case 'signed-out':
			return words('lock', `Sign in to sync · ${upTo999(status.waiting)} waiting`, true);
		case 'passkey':
			return words('passkey', 'Finish adding your passkey', true);
	}
}
