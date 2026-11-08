/**
 * A SvelteKit form action's answer, read outside a browser: tooling that posts to an action (the
 * seeded Lighthouse run) gets `{type, status, data}` JSON whose `data` is devalue-encoded. devalue
 * is only a dependency of SvelteKit's, so this reads its flat format for the plain data actions
 * return (objects, arrays, strings, numbers, booleans, null, undefined), and refuses any other
 * type rather than guess.
 */

export interface ActionAnswer {
	type: string;
	status?: number;
	location?: string;
	data?: unknown;
}

/** devalue's encodings of values JSON has no literal for. */
const SPECIAL: Readonly<Record<number, unknown>> = {
	[-1]: undefined,
	[-3]: Number.NaN,
	[-4]: Number.POSITIVE_INFINITY,
	[-5]: Number.NEGATIVE_INFINITY,
	[-6]: -0
};

/** devalue.parse for plain data: index 0 is the root, and containers hold indices. */
export function unflatten(encoded: string): unknown {
	const values = JSON.parse(encoded) as unknown;
	if (typeof values === 'number') return SPECIAL[values];
	if (!Array.isArray(values)) throw new TypeError('Not a devalue payload');
	const hydrate = (index: number): unknown => {
		if (index in SPECIAL) return SPECIAL[index];
		if (index < 0) throw new TypeError(`Unsupported devalue constant ${index}`);
		const value: unknown = values[index];
		if (value === null || typeof value !== 'object') return value;
		if (Array.isArray(value)) {
			if (typeof value[0] === 'string') throw new TypeError(`Unsupported devalue type ${value[0]}`);
			return value.map((i: number) => hydrate(i));
		}
		return Object.fromEntries(
			Object.entries(value as Record<string, number>).map(([key, i]) => [key, hydrate(i)])
		);
	};
	return hydrate(0);
}

/** An action's answer, with `data` decoded. */
export function readActionAnswer(body: string): ActionAnswer {
	const answer = JSON.parse(body) as ActionAnswer;
	return typeof answer.data === 'string' ? { ...answer, data: unflatten(answer.data) } : answer;
}
