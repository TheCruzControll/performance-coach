/**
 * The current exercise, painted before the app starts (docs/performance.md, /workout's LCP).
 * /workout is prerendered with no data and its workout lives on the device, so its exercise card
 * could paint only once the whole app had started. This device keeps a compact snapshot of exactly
 * what the card shows in localStorage; PREPAINT_SCRIPT, inline in the prerendered page
 * (routes/workout/Prepaint.svelte), reads it synchronously and paints the card in the restoring
 * skeleton's place, with the card's structure and classes. The hydrated view replaces it.
 *
 * Never stale, never wrong:
 * - versioned (the key and `v`) and tied to the workout's id; the script ignores anything else
 * - never newer or older than the store: the store drops it on every change it reports
 *   (store.ts), and the strength view writes it again from what it then renders
 *   (StrengthView.svelte), only while the workout is in progress and every change of it is
 *   written here
 * - a workout page that shows anything but a workout in progress drops it (Shell.svelte)
 * - never while signed out: a 401's purge blocks it (a marker the view cannot overwrite) until the
 *   server answers as the owner again; sign-out deletes it (signout.ts, by this key)
 * - only what the card shows: the exercise's name, place and prescription, its sets in words
 * Storage that is missing, blocked or full is never an error.
 *
 * The same script starts the workout's reconcile GET (reconcile.ts) as the parser reaches it, so a
 * cold load fetches the server's rows alongside the app's chunks rather than after them (online.ts
 * takes the request it left in EARLY_ROWS, or aborts it).
 *
 * No imports: vite.config.ts imports PREPAINT_SCRIPT to allow it by its CSP hash.
 */

export const PREPAINT_KEY = 'pc:workout-prepaint:v1';

/** Where the inline script leaves the GET it started of the kept workout's rows (EarlyRows). */
export const EARLY_ROWS = '__pcEarlyRows';

/** The GET of /api/workouts/[id] the inline script started, and what aborts it. */
export interface EarlyRows {
	workoutId: string;
	response: Promise<Response>;
	controller: AbortController;
}

/** What the key holds while signed out: the view's writes leave it in place. */
const BLOCKED = '{"v":1,"blocked":true}';

/** What the card says of the current exercise's first render (ExerciseCard's default). */
const NO_PREVIOUS = 'Last time · none yet';

export type PrepaintRowState =
	'todo' | 'current' | 'done' | 'skipped' | 'extra' | 'missed' | 'not-saved';

export interface PrepaintLoad {
	kind: 'weight' | 'instruction' | 'note';
	text: string;
}

/** A set row as SetRow draws it: a button (edit) once logged, a plate button for a bar's load. */
export interface PrepaintRow {
	index: number;
	state: PrepaintRowState;
	text: string;
	word: string;
	edit: boolean;
	plates: boolean;
}

/** What ExerciseCard shows, as the strength view's first render gives it. */
export interface PrepaintCard {
	label: string | null;
	place: string;
	name: string;
	/** The quick actions' Options button: an exercise not ended. */
	options: boolean;
	status: { text: string; instead: string | null } | null;
	/** The prescription lines, joined. */
	lines: string;
	load: PrepaintLoad | null;
	loads: (PrepaintLoad | null)[];
	rest: string | null;
	rests: (string | null)[];
	/** Last time's heading, and its sets (none when nothing was logged before). */
	last: string;
	chips: string[] | null;
	rows: PrepaintRow[];
}

export interface PrepaintSnapshot {
	v: 1;
	workoutId: string;
	/** A rest is shown: from 1024 px its timer sits above the card, so none is painted there. */
	rest: boolean;
	card: PrepaintCard;
}

/** The strength view's current exercise (StrengthView.svelte), as much of it as the card shows. */
export interface CardWords {
	name: string;
	label?: string | null;
	place: string;
	lines: string[];
	load: PrepaintLoad | null;
	loads: (PrepaintLoad | null)[];
	rest: string | null;
	rests: (string | null)[];
	previous: { heading: string; sets: string[] } | null;
	status: { text: string; instead: string | null } | null;
	ended: boolean;
	rows: readonly {
		setIndex: number;
		state: PrepaintRowState;
		text: string;
		word: string;
		set?: unknown;
		plates?: unknown;
	}[];
}

/**
 * The card as the view's first render draws it: Last time's heading before any lookup of a
 * substitute's previous sets has answered (the view's lookups start empty).
 */
export function prepaintCard(words: CardWords): PrepaintCard {
	return {
		label: words.label ?? null,
		place: words.place,
		name: words.name,
		options: !words.ended,
		status: words.status && { text: words.status.text, instead: words.status.instead },
		lines: words.lines.join(' · '),
		load: words.load,
		loads: words.loads,
		rest: words.rest,
		rests: words.rests,
		last: words.previous?.heading ?? NO_PREVIOUS,
		chips: words.previous?.sets ?? null,
		rows: words.rows.map((row) => ({
			index: row.setIndex,
			state: row.state,
			text: row.text,
			word: row.word,
			edit: !!row.set,
			plates: !!row.plates
		}))
	};
}

/** The part of localStorage the snapshot uses. */
export type PrepaintStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The page's localStorage, or null where there is none or touching it throws (blocked storage). */
function pageStorage(): PrepaintStorage | null {
	try {
		return (globalThis as { localStorage?: Storage }).localStorage ?? null;
	} catch {
		return null;
	}
}

/** Runs `use` on the storage; a failure (missing, blocked, full) is ignored. */
function attempt(storage: PrepaintStorage | null, use: (storage: PrepaintStorage) => void) {
	if (!storage) return;
	try {
		use(storage);
	} catch {
		// Storage refused: the page paints its skeleton instead, as before.
	}
}

/** Keeps the card for the next load; nothing while signed out (blocked). */
export function writePrepaint(
	snapshot: Omit<PrepaintSnapshot, 'v'>,
	storage = pageStorage()
): void {
	attempt(storage, (s) => {
		if (s.getItem(PREPAINT_KEY) === BLOCKED) return;
		s.setItem(PREPAINT_KEY, JSON.stringify({ v: 1, ...snapshot }));
	});
}

/** Drops the card (the block stays): the next load paints the skeleton. */
export function clearPrepaint(storage = pageStorage()): void {
	attempt(storage, (s) => {
		if (s.getItem(PREPAINT_KEY) !== BLOCKED) s.removeItem(PREPAINT_KEY);
	});
}

/** Signed out (a 401's purge): no card, and none written until unblockPrepaint. */
export function blockPrepaint(storage = pageStorage()): void {
	attempt(storage, (s) => s.setItem(PREPAINT_KEY, BLOCKED));
}

/** The server answered as the owner again: the view may keep the card again. */
export function unblockPrepaint(storage = pageStorage()): void {
	attempt(storage, (s) => {
		if (s.getItem(PREPAINT_KEY) === BLOCKED) s.removeItem(PREPAINT_KEY);
	});
}

/**
 * The inline script (Prepaint.svelte puts it right after its empty, hidden container): with a
 * valid snapshot, and no ?start or ?new, it builds the card into the container and shows it, all
 * or nothing, then (online) starts the GET of the workout's rows, as reconcile.ts's workoutUrl
 * asks it. Text only through textContent and attributes, never as markup. Every field is
 * checked as it is used: anything malformed throws, and nothing is shown. ES2017, no modules:
 * it runs as the parser reaches it, before the first paint, on every engine the app supports.
 */
export const PREPAINT_SCRIPT = `(function () {
	try {
		var d = document,
			root = d.currentScript.previousElementSibling,
			s = JSON.parse(localStorage.getItem('${PREPAINT_KEY}'));
		if (/[?&](start|new)=/.test(location.search) || !s || s.v !== 1) return;
		if (typeof s.workoutId != 'string') return;
		var c = s.card,
			sprite = root.getAttribute('data-sprite'),
			text = function (x) {
				if (typeof x != 'string') throw 0;
				return x;
			},
			list = function (x) {
				if (!Array.isArray(x)) throw 0;
				return x;
			},
			kind = function (load) {
				if (!/^(weight|instruction|note)$/.test(load.kind)) throw 0;
				return load.kind;
			},
			el = function (parent, tag, cls, words) {
				var e = d.createElement(tag);
				if (cls) e.className = cls;
				if (arguments.length > 3) e.textContent = text(words);
				if (parent) parent.appendChild(e);
				return e;
			},
			icon = function (parent, name, size) {
				var ns = 'http://www.w3.org/2000/svg',
					svg = d.createElementNS(ns, 'svg'),
					use = d.createElementNS(ns, 'use');
				svg.setAttribute('class', 'icon');
				svg.setAttribute('width', size);
				svg.setAttribute('height', size);
				svg.setAttribute('viewBox', '0 0 24 24');
				use.setAttribute('href', sprite + '#' + name);
				svg.appendChild(use);
				parent.appendChild(svg);
			};
		var card = el(null, 'section', 'card'),
			head = el(card, 'header', 'head'),
			place = el(head, 'p', 'place');
		if (c.label != null) el(place, 'span', 'badge', c.label);
		el(place, 'span', '', c.place);
		var title = el(head, 'div', 'title');
		icon(el(el(title, 'h2'), 'span', 'history', c.name), 'chevron-right', 20);
		if (c.options) {
			var options = el(title, 'span', 'btn');
			icon(options, 'refresh', 20);
			el(options, 'span', 'label', 'Options');
		}
		if (c.status) {
			var state = el(head, 'p', 'state');
			el(state, 'strong', '', c.status.text);
			if (c.status.instead != null) el(state, 'span', '', 'Instead of ' + text(c.status.instead));
		}
		var target = el(card, 'div', 'target');
		el(target, 'p', 'lines', c.lines);
		var loads = el(target, 'div', 'stack');
		if (c.load) el(loads, 'p', 'load', c.load.text).setAttribute('data-kind', kind(c.load));
		list(c.loads).forEach(function (load) {
			if (!load) return;
			var ghost = el(loads, 'p', 'load ghost');
			ghost.setAttribute('data-kind', kind(load));
			ghost.setAttribute('data-text', text(load.text));
		});
		var rests = el(target, 'div', 'stack');
		if (c.rest != null) el(rests, 'p', 'rest', c.rest);
		list(c.rests).forEach(function (rest) {
			if (rest != null) el(rests, 'p', 'rest ghost').setAttribute('data-text', text(rest));
		});
		var previous = el(card, 'div', 'previous');
		el(previous, 'h3', '', c.last);
		if (c.chips) {
			var chips = el(previous, 'ol', 'chips');
			list(c.chips).forEach(function (chip) {
				el(chips, 'li', '', chip);
			});
		}
		var sets = el(card, 'ol', 'sets');
		list(c.rows).forEach(function (row) {
			if (!/^(todo|current|done|skipped|extra|missed|not-saved)$/.test(row.state)) throw 0;
			if (typeof row.index != 'number') throw 0;
			var li = el(sets, 'li', row.plates ? 'plated' : ''),
				set = el(li, 'div', row.edit ? 'set edit' : 'set');
			li.setAttribute('data-state', row.state);
			el(set, 'span', 'index tabular', String(row.index));
			el(set, 'span', 'text', row.text);
			el(el(set, 'span', 'state'), 'span', '', row.word);
			if (row.plates) icon(el(li, 'span', 'plate'), 'plate', 22);
		});
		root.appendChild(card);
		if (s.rest) root.setAttribute('data-rest', '');
		root.hidden = false;
		if (navigator.onLine !== false) {
			var a = new AbortController();
			(window['${EARLY_ROWS}'] = {
				workoutId: s.workoutId,
				controller: a,
				response: fetch('/api/workouts/' + encodeURIComponent(s.workoutId), {
					headers: { accept: 'application/json' },
					signal: a.signal
				})
			}).response.catch(function () {});
		}
	} catch (e) {}
})();`;
