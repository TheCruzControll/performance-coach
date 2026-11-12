/**
 * vercel.json's `headers` rules, compiled for the local TLS proxy (pure; scripts/e2e-tls.test.ts).
 *
 * adapter-node and sirv never read vercel.json, so a local run would never see the headers Vercel
 * adds to a matching path (the prerendered pages' STATIC_PAGE_HEADERS). The proxy applies them as
 * Vercel does: every rule whose `source` matches the request's pathname, in file order, a later
 * rule's value winning for the same header.
 *
 * Supported `source` syntax, the subset of path-to-regexp vercel.json uses: literal characters,
 * `:param` (one path segment), `:param*` (zero or more segments) and `(.*)` (anything). Anything
 * else throws, so a new rule can never be skipped in silence: extend the compiler with it.
 */

export interface VercelHeader {
	key: string;
	value: string;
}

export interface VercelHeaderRule {
	source: string;
	headers: VercelHeader[];
}

export interface HeaderRules {
	/** The headers of every rule that matches `pathname`, in file order (lower-cased keys). */
	headersFor(pathname: string): [key: string, value: string][];
}

/** Characters a literal segment may hold: anything that is not path-to-regexp syntax. */
const LITERAL = /^[A-Za-z0-9\-._~/%!$&',;=@]$/;
const PARAM = /^:([A-Za-z_][A-Za-z0-9_]*)(\*)?/;
const ANYTHING = '(.*)';

const escape = (char: string) => char.replace(/[.$]/g, '\\$&');

/** `source` as an anchored regular expression, or a throw naming what it cannot read. */
export function compileSource(source: string): RegExp {
	if (!source.startsWith('/')) throw new Error(`vercel.json source ${source}: must start with /`);
	let pattern = '';
	let rest = source;
	while (rest.length > 0) {
		const param = PARAM.exec(rest);
		if (param) {
			// `:param*` also matches nothing, swallowing the slash before it (/a/:p* matches /a).
			if (param[2]) {
				if (!pattern.endsWith('/')) {
					throw new Error(`vercel.json source ${source}: :${param[1]}* must follow a /`);
				}
				pattern = `${pattern.slice(0, -1)}(?:/.*)?`;
			} else {
				pattern += '[^/]+';
			}
			rest = rest.slice(param[0].length);
		} else if (rest.startsWith(ANYTHING)) {
			pattern += '.*';
			rest = rest.slice(ANYTHING.length);
		} else if (LITERAL.test(rest[0]!)) {
			pattern += escape(rest[0]!);
			rest = rest.slice(1);
		} else {
			throw new Error(
				`vercel.json source ${source}: unsupported syntax at "${rest}" (scripts/e2e-tls/vercel-headers.ts reads literals, :param, :param* and (.*))`
			);
		}
	}
	return new RegExp(`^${pattern}$`);
}

/** vercel.json's header rules, ready to match request paths. Throws on a source it cannot read. */
export function compileHeaderRules(vercelJson: { headers?: VercelHeaderRule[] }): HeaderRules {
	const rules = (vercelJson.headers ?? []).map((rule) => ({
		match: compileSource(rule.source),
		headers: rule.headers.map(({ key, value }) => [key.toLowerCase(), value] as [string, string])
	}));
	return {
		headersFor(pathname) {
			return rules.filter((rule) => rule.match.test(pathname)).flatMap((rule) => rule.headers);
		}
	};
}
