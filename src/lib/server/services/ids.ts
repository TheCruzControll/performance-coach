/**
 * Ids from outside (form fields, route params, the coach's tool calls in M5) are checked by shape
 * before they reach a query: Postgres refuses a malformed uuid with an error (22P02) instead of
 * finding nothing, which would surface as a 500. A service answers "not found" for them itself.
 */
import { z } from 'zod';

const uuid = z.uuid();

/** A well-formed UUID: the only shape a generated primary key can have. */
export function isUuid(value: unknown): value is string {
	return uuid.safeParse(value).success;
}
