/**
 * The taper rules (m7/17 deload-taper): each event kind's taper, what a taper keeps, the meet's
 * openers and the taper by priority, with the functions that apply them. The ids are the rule
 * keys taperWeeks' plans cite.
 */
import { BY_PRIORITY, MEET_TAPER, TAPER_SESSIONS, TAPERS } from '../taper.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/rules/taper.ts';

const taper = (event: keyof typeof TAPERS, statement: string): RuleDefinition => ({
	id: `taper.${event}`,
	kind: 'constant',
	statement,
	rationale: TAPERS[event].why,
	source: `${FILE}#TAPERS.${event}`,
	values: TAPERS[event]
});

export const rules: readonly RuleDefinition[] = [
	taper(
		'marathon',
		'A marathon is tapered over 3 weeks, at 80, 60 and 40 % of the planned volume.'
	),
	taper('half', 'A half marathon is tapered over 2 weeks, at 70 and 50 % of the planned volume.'),
	taper('other', 'A 5K to 10K race is tapered over 1 week, at 60 % of the planned volume.'),
	taper(
		'meet',
		'A powerlifting meet is tapered over 1 week at half the sets, with openers at about 90 % 4–5 days out and no heavy lower body in the last 3 days.'
	),
	taper(
		'fight',
		'A fight is tapered over its fight week, which the fight camp plans as technical.'
	),
	{
		id: 'taper.sessions',
		kind: 'constant',
		statement:
			'A taper cuts volume and keeps intensity; an endurance taper keeps one short strength session a week at least 4 days out, and the last week’s Muay Thai is technical.',
		rationale: TAPER_SESSIONS.why,
		source: `${FILE}#TAPER_SESSIONS`,
		values: TAPER_SESSIONS
	},
	{
		id: 'taper.meet_openers',
		kind: 'constant',
		statement:
			'In a meet taper, each lift’s opener is a single at about 90 % 4–5 days out, and the last 3 days hold nothing heavy for the legs.',
		rationale: MEET_TAPER.why,
		source: `${FILE}#MEET_TAPER`,
		values: MEET_TAPER
	},
	{
		id: 'taper.priority',
		kind: 'constant',
		statement:
			'The leading goal’s event gets its full taper, a secondary event a 3-day mini-taper at 60 %, and a low-priority event is trained through.',
		rationale: BY_PRIORITY.why,
		source: `${FILE}#BY_PRIORITY`,
		values: BY_PRIORITY
	},
	{
		id: 'taper.apply',
		kind: 'behaviour',
		statement:
			'A taper changes the volume of the sessions it reaches, on the same days with the same exercises, and removes an endurance taper’s extra strength sessions.',
		rationale:
			'Keeping the days and the work familiar while the volume falls lets you arrive fresh without feeling flat.',
		source: 'src/lib/domain/programming/periodisation/taper.ts#taperSessions'
	}
];
