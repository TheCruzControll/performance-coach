/**
 * Recent security activity for Profile → Security, from the audit log (`auth_events`).
 */
import { createAuthRepository, type AuthEventType } from '../db';
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
	signout: { label: 'Signed out', tone: 'neutral' },
	rate_limited: { label: 'Too many attempts blocked', tone: 'warning' },
	'owner.reset': { label: 'Passkeys reset by the administrator', tone: 'warning' }
};

export async function recentAuthActivity(
	_session: AuthSession,
	limit = 8,
	deps: AuthDeps = {}
): Promise<AuthActivity[]> {
	const { db } = resolveDeps(deps);
	const rows = await createAuthRepository(db).recentEvents(limit);
	return rows.map((row) => ({
		id: row.id,
		at: row.occurredAt,
		...LABELS[row.type],
		device: row.userAgent
	}));
}
