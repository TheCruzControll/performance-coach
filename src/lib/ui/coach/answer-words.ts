/**
 * What the coach's answer components say (PRD §12): a source's dated name, a block's words as
 * plain text, and what the live region announces. Read from the stream's finished blocks
 * (domain/coach/events.ts) and calendar strings (`YYYY-MM-DD`), never from the device's clock or
 * time zone, and without Intl (docs/performance.md).
 */
import {
	ANSWER_BLOCK_KIND_LABEL,
	SOURCE_TYPE_LABEL,
	type CompletedBlock,
	type RichNode,
	type SourceRef
} from '#lib/domain/coach/index.ts';
import { parseIsoDate } from '#lib/domain/calendar.ts';

/**
 * Owner decision (M5 plan, coach-answer-kit): an answer shows its first 12 blocks, and 'Show all'
 * reveals the rest, so one long answer never buries the conversation around it. One number here.
 */
export const ANSWER_BLOCKS_SHOWN = 12;

/** The badge on a block the output policy could not check against this turn's data. */
export const UNCHECKED_LABEL = 'Not checked against your data';

/** The live region's last words for a turn. */
export const ANSWER_COMPLETE = 'Answer complete';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'Tue 3 Nov 2026', or null for a missing or impossible day. The year is always written. */
export function sourceDate(date: string | undefined): string | null {
	const day = date === undefined ? null : parseIsoDate(date);
	if (!day) return null;
	return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
}

/** A source as its row shows it: what it is called, then what kind of record and its day. */
export interface SourceWords {
	/** The ref's label; else its day for a date; else the kind of record. Never a raw id. */
	title: string;
	/** 'Workout', 'Planned session'…; null when the title already says it. */
	kind: string | null;
	date: string | null;
	/** The day `date` words, `YYYY-MM-DD`, for `<time datetime>`. */
	day: string | null;
}

export function sourceWords(ref: SourceRef): SourceWords {
	const kind = SOURCE_TYPE_LABEL[ref.type];
	const iso = ref.type === 'date' ? ref.id : ref.date;
	const date = sourceDate(iso);
	const day = date === null ? null : (iso ?? null);
	const label = ref.label?.trim();
	if (label) return { title: label, kind, date, day };
	if (ref.type === 'date' && date) return { title: date, kind, date: null, day: null };
	return { title: kind, kind: null, date, day };
}

/** The accessible name of a source's link or button, in the order its row reads. */
export function sourceName(ref: SourceRef): string {
	const { title, kind, date } = sourceWords(ref);
	return [title, kind, date].filter((part) => part !== null).join(', ');
}

/** A rich-text tree's words, as one line of plain text. */
export function plainText(nodes: readonly RichNode[]): string {
	const parts: string[] = [];
	const walk = (node: RichNode) => {
		switch (node.type) {
			case 'text':
			case 'code':
				parts.push(node.text);
				break;
			case 'ref':
				parts.push(node.label);
				break;
			case 'paragraph':
			case 'list':
			case 'item':
				parts.push(' ');
				node.children.forEach(walk);
				parts.push(' ');
				break;
			default:
				node.children.forEach(walk);
		}
	};
	nodes.forEach(walk);
	return parts.join('').replace(/\s+/g, ' ').trim();
}

/** What the live region says when a block completes: its label, its words, and if unchecked. */
export function blockAnnouncement(
	block: Pick<CompletedBlock, 'kind' | 'ast' | 'grounded'>
): string {
	const words = `${ANSWER_BLOCK_KIND_LABEL[block.kind]}: ${plainText(block.ast)}`;
	return block.grounded ? words : `${words} (${UNCHECKED_LABEL})`;
}
