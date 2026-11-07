// The words for the statechart skill's report on MC.cfg's scenario: 1 logs set S, 2 and 3 edit it.
const NAME = { 1: 'log of set S', 2: 'first edit of S', 3: 'second edit of S' };
const list = (xs) => (xs.length ? xs.join(', ') : 'nothing');
const seq = (s) => Object.values(s ?? {});

function outbox(box) {
	return Object.entries(box)
		.filter(([, e]) => e.in)
		.map(([m, e]) => {
			const how = e.park !== 'none' ? ` (${e.park})` : e.wait ? ' (waiting)' : '';
			return NAME[m] + how;
		});
}

const logged = (n) => [1, 2, 3].filter((m) => m <= n).map((m) => NAME[m]);

export const state = (v) =>
	`You logged: ${list(logged(v.logged))}. Server applied: ${list(seq(v.history).map((m) => NAME[m]))}. ` +
	`Outbox: ${list(outbox(v.box))}. Requests out: ${seq(v.reqs).length}.`;

const changed = (from, to) => seq(to.history).slice(seq(from.history).length);

/** What the server answered for the change it just ran: the open request that changed. */
function answer(from, to) {
	const after = new Set(seq(to.reqs).map((r) => JSON.stringify(r)));
	const r = seq(from.reqs).find((q) => q.st === 'open' && !after.has(JSON.stringify(q)));
	const m = seq(r.batch)[r.i - 1];
	if (changed(from, to).length) return `the server applies the ${NAME[m]}`;
	if (seq(from.ledger).includes(m)) return `the server answers 'duplicate' for the ${NAME[m]}`;
	if (!seq(r.ok).includes(m)) return `the server answers 'rejected' for the ${NAME[m]}`;
	return `the server answers 'deferred' for the ${NAME[m]}`;
}

export function step(action, from, to) {
	switch (action) {
		case 'Log':
			return `you log the ${NAME[to.logged]}`;
		case 'StartRound':
			return `a tab posts ${list(seq(seq(to.reqs).at(-1).batch).map((m) => NAME[m]))}`;
		case 'EndRound':
			return 'the tab finds nothing more to send';
		case 'Receive':
			return 'the tab stores the answer (acknowledge)';
		case 'ReceiveFailed':
			return 'the tab gets a 5xx or a dead request';
		case 'Timeout':
			return 'the POST times out or its answer is lost';
		case 'Keepalive':
			return `the page is hidden: keepalive posts ${list(seq(seq(to.reqs).at(-1).batch).map((m) => NAME[m]))}`;
		case 'WaitEnds':
			return 'a backoff wait ends';
		case 'Fix':
			return 'you fix the refused change';
		case 'TryAgain':
			return 'you press Try again';
		case 'Discard':
			return 'you press Discard';
		case 'ServerStep':
			return answer(from, to);
		case 'ServerError': {
			const applied = changed(from, to);
			return applied.length
				? `the server commits the ${NAME[applied[0]]}, then the database connection fails`
				: 'a database error stops the batch';
		}
		case 'ServerDies':
			return 'the server function dies mid-batch';
		case 'Dropped':
			return 'a request nobody waits for is lost';
		case 'Done':
			return 'everything is synced';
		default:
			return action;
	}
}
