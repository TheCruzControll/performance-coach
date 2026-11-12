/**
 * What the Coach screens show, in words composed on the server (coach.server.ts), so they cost
 * the screen no JavaScript: a conversation row's title and when it was last active, a stored
 * message as the screen draws it, and the question an entry point prefilled.
 */
import type { ProposalCardView } from '#lib/domain/coach/cards.ts';
import type { CompletedBlock } from '#lib/domain/coach/index.ts';
import { parseRef, type SourceRef } from '#lib/domain/coach/sources.ts';
import { MESSAGE_STATUS_LABEL, type MessageStatus } from '#lib/domain/coach/vocabulary.ts';
import { addDays } from '#lib/domain/calendar.ts';
import { localDay } from '#lib/domain/dates.ts';
import { COMPOSER_MAX_CHARS } from '#lib/ui/coach/composer-keys.ts';
import { shortDate } from '#lib/ui/program/words.ts';

/** A conversation in Recent conversations: one link, everything it says in words. */
export interface ThreadRowView {
	id: string;
	title: string;
	/** When its last message was: 'Today · 09:14', 'Yesterday · 18:30', 'Mon 2 Nov'. */
	when: string;
}

/** A stored message as the conversation shows it. */
export type ShownMessage =
	| {
			id: string;
			from: 'owner';
			text: string;
			/** The device's id it was sent with: Retry sends it again under the same id. */
			clientId: string | null;
	  }
	| {
			id: string;
			from: 'coach';
			blocks: CompletedBlock[];
			/** How an answer that did not complete ended ('Stopped'); null for a complete one. */
			ended: string | null;
			/** Interrupted or failed, not stopped: the question can be asked again (Retry). */
			retryable: boolean;
	  }
	| {
			/** The proposal's id. */
			id: string;
			from: 'proposal';
			card: ProposalCardView;
	  };

/** A stored row the screen may show (services/coach/threads.ts getThreadView). */
export interface DisplayedRow {
	id: string;
	kind: string;
	status: MessageStatus;
	display: Record<string, unknown> | null;
	clientMessageId?: string | null;
	/** The run that wrote it; null for none. */
	runId?: string | null;
}

/** A card for a proposal run `runId` made. */
export interface RunCard {
	runId: string;
	card: ProposalCardView;
}

/**
 * Where a prefilled question came from, by the entry's `from`, in the chip's words. Owner
 * decision (M5 plan, entry points): an entry this list does not name prefills its question with
 * no chip; coach-entry-points adds the rows its entry points send.
 */
export const ENTRY_LABEL: Readonly<Record<string, string>> = Object.freeze({
	workout: 'From your workout',
	exercise: 'From an exercise’s history',
	today: 'From Today'
});

/**
 * The question an entry point opened Coach with (?ask=…&from=…&ref=…, built by ui/ask-link.ts),
 * and its chip's words.
 */
export interface Prefill {
	text: string;
	/** The entry's `from`, as the turn endpoint takes it; null when none or malformed. */
	from: string | null;
	/** The chip's words; null when the entry has none. */
	label: string | null;
	/** What the entry is about (`ref=type:id`), sent with the first turn; null without an entry. */
	ref: SourceRef | null;
}

/** The turn endpoint's rule for an entry's `from` (api/coach/turns). */
const ENTRY_FROM = /^[a-z][a-z_]{0,31}$/;

/**
 * The prefill in a /coach URL: `ask` (trimmed, at most the composer's limit), `from`, and `ref`
 * when it is a source ref (parseRef, with no label) and `from` is valid.
 */
export function prefillOf(search: URLSearchParams): Prefill | null {
	const text = Array.from((search.get('ask') ?? '').trim())
		.slice(0, COMPOSER_MAX_CHARS)
		.join('')
		.trim();
	if (text === '') return null;
	const raw = search.get('from');
	const from = raw !== null && ENTRY_FROM.test(raw) ? raw : null;
	const ref = from === null ? null : parseRef(search.get('ref') ?? '');
	return {
		text,
		from,
		label: (from !== null && Object.hasOwn(ENTRY_LABEL, from) && ENTRY_LABEL[from]) || null,
		ref: ref && !ref.label ? ref : null
	};
}

function timeOf(at: Date, timeZone: string) {
	return new Intl.DateTimeFormat('en-GB', {
		timeZone,
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	}).format(at);
}

/** When a conversation was last active, in the owner's zone: today and yesterday with a time. */
export function whenWords(at: Date, now: Date, timeZone: string): string {
	const day = localDay(at, timeZone);
	const today = localDay(now, timeZone);
	if (day === today) return `Today · ${timeOf(at, timeZone)}`;
	if (day === addDays(today, -1)) return `Yesterday · ${timeOf(at, timeZone)}`;
	return shortDate(day);
}

/** When a conversation was archived, in the owner's zone: 'Archived today · 09:14', 'Archived Mon 2 Nov'. */
export function archivedWords(at: Date, now: Date, timeZone: string): string {
	return `Archived ${whenWords(at, now, timeZone).replace(/^(Today|Yesterday)/, (day) => day.toLowerCase())}`;
}

const isBlocks = (value: unknown): value is CompletedBlock[] =>
	Array.isArray(value) &&
	value.every((block) => typeof block === 'object' && block !== null && 'kind' in block);

/**
 * The rows a conversation shows, in order: the owner's messages and the coach's answers, a
 * partial answer (display_only) with how it ended. A row with nothing to show is left out. Each
 * proposal card follows the last row of the run that proposed it; a card whose run has no row
 * here is left out (it belongs to another page).
 */
export function shownMessages(
	rows: readonly DisplayedRow[],
	cards: readonly RunCard[] = []
): ShownMessage[] {
	const lastOfRun = new Map<string, number>();
	rows.forEach((row, at) => row.runId && lastOfRun.set(row.runId, at));
	return rows.flatMap((row, at): ShownMessage[] => {
		const shown = shownMessage(row);
		if (!row.runId || lastOfRun.get(row.runId) !== at) return shown;
		const own = cards.filter((each) => each.runId === row.runId);
		return [
			...shown,
			...own.map(({ card }): ShownMessage => ({ id: card.id, from: 'proposal', card }))
		];
	});
}

function shownMessage(row: DisplayedRow): ShownMessage[] {
	const display = row.display ?? {};
	if (row.kind === 'owner_message') {
		return typeof display.text === 'string'
			? [{ id: row.id, from: 'owner', text: display.text, clientId: row.clientMessageId ?? null }]
			: [];
	}
	if (row.kind !== 'assistant' && row.kind !== 'display_only') return [];
	if (!isBlocks(display.blocks) || display.blocks.length === 0) return [];
	const ended = row.status === 'complete' ? null : MESSAGE_STATUS_LABEL[row.status];
	const retryable = row.status === 'interrupted' || row.status === 'failed';
	return [{ id: row.id, from: 'coach', blocks: display.blocks, ended, retryable }];
}
