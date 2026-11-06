/**
 * Recent security activity for Profile → Security, from the audit log (`auth_events`).
 *
 * Anyone can write failed attempts into the log, without credentials and from any number of
 * addresses, so a plain "newest N events" feed could be flooded until a recovery code used or
 * a passkey added scrolled out of it. Instead each unbroken run of failed attempts is one row,
 * and the latest security changes always keep their place.
 */
import { createAuthRepository, type AuthEventRow, type AuthEventType } from '../db';
import { resolveDeps, type AuthDeps } from './context';
import type { AuthSession } from './sessions';

export type ActivityTone = 'neutral' | 'positive' | 'warning';

export interface AuthActivity {
	id: number;
	at: Date;
	label: string;
	tone: ActivityTone;
	device: string | null;
}

const LABELS: Record<AuthEventType, { label: string; tone: ActivityTone }> = {
	'setup.completed': { label: 'Account set up', tone: 'positive' },
	'setup.failed': { label: 'Setup attempt refused', tone: 'warning' },
	'signin.succeeded': { label: 'Signed in with a passkey', tone: 'neutral' },
	'signin.failed': { label: 'Sign-in attempt failed', tone: 'warning' },
	'passkey.added': { label: 'Passkey added', tone: 'positive' },
	'passkey.renamed': { label: 'Passkey renamed', tone: 'neutral' },
	'passkey.removed': { label: 'Passkey removed', tone: 'neutral' },
	'recovery.used': { label: 'Recovery code used', tone: 'warning' },
	'recovery.failed': { label: 'Recovery code rejected', tone: 'warning' },
	'recovery.regenerated': { label: 'New recovery codes created', tone: 'neutral' },
	'session.revoked': { label: 'Signed out another device', tone: 'neutral' },
	'session.revoked_others': { label: 'Signed out everywhere else', tone: 'neutral' },
	'reauth.succeeded': { label: 'Confirmed with a passkey', tone: 'neutral' },
	'reauth.failed': { label: 'Passkey confirmation failed', tone: 'warning' },
	signout: { label: 'Signed out', tone: 'neutral' },
	rate_limited: { label: 'Too many attempts blocked', tone: 'warning' },
	'owner.reset': { label: 'Passkeys reset by the administrator', tone: 'warning' }
};

/** Refused attempts to get in: the events anyone can cause. */
const ATTEMPTS = new Set<AuthEventType>([
	'signin.failed',
	'setup.failed',
	'recovery.failed',
	'rate_limited'
]);

/** Changes to who can get in, or who is in. */
const SIGNIFICANT: readonly AuthEventType[] = [
	'setup.completed',
	'passkey.added',
	'passkey.removed',
	'recovery.used',
	'recovery.regenerated',
	'session.revoked',
	'session.revoked_others',
	'owner.reset'
];

/** Events read to build the feed: a run of attempts reaching back this far shows as "50+". */
const WINDOW = 50;

const newestFirst = (a: AuthEventRow, b: AuthEventRow) =>
	b.occurredAt.getTime() - a.occurredAt.getTime() || b.id - a.id;

export async function recentAuthActivity(
	_session: AuthSession,
	limit = 8,
	deps: AuthDeps = {}
): Promise<AuthActivity[]> {
	const { db } = resolveDeps(deps);
	const repo = createAuthRepository(db);
	// Half the feed is kept for the latest security changes, however much happened since.
	const [recent, significant] = await Promise.all([
		repo.recentEvents(WINDOW),
		repo.recentEvents(Math.floor(limit / 2), SIGNIFICANT)
	]);
	// Older events were not read: a run of attempts that reaches the oldest one may go on.
	const cutoff = recent.length === WINDOW ? recent.at(-1)!.id : null;
	const rows = [...new Map([...recent, ...significant].map((r) => [r.id, r])).values()];

	const items: (AuthActivity & { attempts: number; more: boolean })[] = [];
	for (const row of rows.sort(newestFirst)) {
		const attempt = ATTEMPTS.has(row.type);
		const more = attempt && row.id === cutoff;
		const run = items.at(-1);
		if (attempt && run?.attempts) {
			run.attempts += 1;
			run.more ||= more;
			if (run.device !== row.userAgent) run.device = null;
		} else {
			items.push({
				id: row.id,
				at: row.occurredAt,
				...LABELS[row.type],
				device: row.userAgent,
				attempts: attempt ? 1 : 0,
				more
			});
		}
	}

	const pinned = new Set(significant.map((r) => r.id));
	let others = limit - pinned.size;
	return items
		.filter((item) => pinned.has(item.id) || others-- > 0)
		.map(({ attempts, more, ...item }) =>
			attempts > 1 || more
				? { ...item, label: `${attempts}${more ? '+' : ''} failed sign-in attempts` }
				: item
		);
}
