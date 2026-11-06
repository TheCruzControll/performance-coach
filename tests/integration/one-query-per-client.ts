/**
 * Per-worker setup: fail the test that sends a query to a pg client while that client is still
 * running another, e.g. a `Promise.all` of reads over one transaction (a single client).
 *
 * node-postgres 8 still queues the extra query and runs it afterwards, but has deprecated that
 * for pg@9. Its DeprecationWarning is printed once per process, only from the third query queued
 * at once, and goes unnoticed in a green run. So this fails on that warning, and also checks the
 * client's own queue on every call, which catches two overlapping queries as well.
 */
import pg from 'pg';
import { afterAll, afterEach } from 'vitest';

const DEPRECATION = 'Calling client.query() when the client is already executing a query';

/** node-postgres 8 internals: the query a client is running and the ones queued behind it. */
interface QueryQueue {
	_activeQuery: unknown;
	_queryQueue: unknown[];
}

let overlap: Error | undefined;

const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (this: pg.Client & QueryQueue, ...args: unknown[]) {
	if (this._activeQuery || this._queryQueue.length > 0) {
		overlap ??= new Error('client.query() was called while this client was running a query');
	}
	return Reflect.apply(query, this, args);
} as typeof query;

function onWarning(warning: Error) {
	if (warning.name === 'DeprecationWarning' && warning.message.startsWith(DEPRECATION)) {
		overlap ??= warning;
	}
}
process.on('warning', onWarning);

function failOnOverlap() {
	const cause = overlap;
	overlap = undefined;
	if (cause) {
		throw new Error(
			'A query was sent to a pg client that was still running another. Await each query in ' +
				'turn on a transaction or connection (no Promise.all over the same `db`).',
			{ cause }
		);
	}
}

afterEach(failOnOverlap);

afterAll(() => {
	pg.Client.prototype.query = query;
	process.off('warning', onWarning);
	failOnOverlap();
});
