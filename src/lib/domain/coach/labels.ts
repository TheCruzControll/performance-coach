/** Label tables: each list in the coach vocabulary is the keys of its label table. */
export type Labels = Readonly<Record<string, string>>;

/**
 * The keys of a label table, in their written order, so no key lacks a label. Free of side
 * effects: a client bundle leaves out the tables and key lists it never reads.
 */
export const keysOf = /* @__NO_SIDE_EFFECTS__ */ <L extends Labels>(labels: L) =>
	Object.keys(labels) as readonly (keyof L & string)[];
