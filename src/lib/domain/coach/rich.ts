/**
 * The rich-text tree an answer block's words travel in. The server parses the model's light
 * markdown into it (domain/coach/markdown.ts), and the screen renders it as elements, never as
 * HTML, so no answer can inject markup. A link's href is always an app path sourceAction allows;
 * a ref's `label` is what the reader sees.
 */
import type { SourceRef } from './sources.ts';

export type RichInline =
	| { type: 'text'; text: string }
	| { type: 'code'; text: string }
	| { type: 'emphasis'; children: RichInline[] }
	| { type: 'strong'; children: RichInline[] }
	| { type: 'link'; href: string; children: RichInline[] }
	| { type: 'ref'; ref: SourceRef; label: string };

export type RichItem = { type: 'item'; children: (RichInline | RichList)[] };
export type RichList = { type: 'list'; ordered: boolean; children: RichItem[] };
export type RichParagraph = { type: 'paragraph'; children: RichInline[] };

export type RichBlock = RichParagraph | RichList;
export type RichNode = RichBlock | RichItem | RichInline;
