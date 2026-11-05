/**
 * Connection security derived from a connection string, shared by every connection the app makes
 * (the app pool and the migrator), so all of them get the same guarantees.
 *
 * Only depends on the platform (`URL`), so `scripts/db-migrate.ts` can run it directly in Node.
 *
 * - TLS: node-postgres 8 treats `sslmode=require` (also `prefer`, `verify-ca`) as `verify-full`:
 *   certificate chain and host name are checked. Its next major switches to libpq semantics,
 *   where `require` no longer verifies the certificate. Neon's certificates are publicly trusted,
 *   so the mode is pinned to `verify-full` here and cannot silently weaken on an upgrade.
 * - SCRAM channel binding: node-postgres ignores the `channel_binding` URL parameter (Neon's
 *   strings carry `channel_binding=require`); its equivalent is the `enableChannelBinding`
 *   option, which uses SCRAM-SHA-256-PLUS whenever the server offers it over TLS.
 */
export interface ConnectionConfig {
	connectionString: string;
	enableChannelBinding: boolean;
}

const WEAK_TLS_MODES = new Set(['prefer', 'require', 'verify-ca']);

export function connectionConfig(url: string): ConnectionConfig {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { connectionString: url, enableChannelBinding: false }; // let pg report it
	}
	const params = parsed.searchParams;
	const sslmode = params.get('sslmode');
	if (sslmode && WEAK_TLS_MODES.has(sslmode)) params.set('sslmode', 'verify-full');
	const binding = params.get('channel_binding');
	params.delete('channel_binding');
	return {
		connectionString: parsed.toString(),
		enableChannelBinding: binding === 'require' || binding === 'prefer'
	};
}
