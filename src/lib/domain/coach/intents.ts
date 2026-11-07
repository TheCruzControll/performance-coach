/**
 * The lookups the coach answers straight from the owner's data, with no model call (the brief:
 * 'answer simple lookups like "what's today's workout" directly … when the intent is
 * unambiguous'). agent/direct.ts reads M3's program and answers with facts. Zod-free and
 * client-safe; imported by path.
 *
 * Unambiguous means the whole message is the question, give or take a greeting, 'coach' or
 * 'please': each pattern is anchored at both ends. Anything more ('Can we change today's
 * workout?', 'How did today's session go?', "today's workout and why", 'next week') is not a
 * lookup, and goes to the model.
 */

export const DIRECT_INTENTS = ['todays_workout', 'this_week', 'next_session'] as const;
export type DirectIntent = (typeof DIRECT_INTENTS)[number];

/** A lookup is short: longer messages always go to the model. */
export const MAX_LOOKUP_CHARS = 80;

const WHAT = "(?:what's|whats|what is|what're|what are)";
const SHOW =
	'(?:show me|show|tell me|give me|can you show me|can you tell me|could you show me|could you tell me)';
const WORKOUT = '(?:workout|workouts|session|sessions|training|plan|program|programme|lift|run)';

const PATTERNS: readonly [RegExp, DirectIntent][] = [
	[new RegExp(`^${WHAT} (?:my |the )?${WORKOUT} (?:for )?today$`), 'todays_workout'],
	[new RegExp(`^${WHAT} (?:on |planned |scheduled )?(?:for )?today$`), 'todays_workout'],
	[
		new RegExp(`^${WHAT} (?:on )?(?:the plan|my plan|the schedule|my schedule) (?:for )?today$`),
		'todays_workout'
	],
	[new RegExp(`^(?:${WHAT} |${SHOW} )?(?:my )?today'?s ${WORKOUT}$`), 'todays_workout'],
	[new RegExp(`^${SHOW} (?:my |the )?${WORKOUT} (?:for )?today$`), 'todays_workout'],
	[
		/^what (?:am i doing|am i training|am i lifting|do i have|have i got|do i do|is on) today$/,
		'todays_workout'
	],
	[
		/^(?:do i|am i) (?:train|training|lift|lifting|have a (?:workout|session)) today$/,
		'todays_workout'
	],
	[new RegExp(`^${WHAT} (?:my |the )?${WORKOUT} (?:for )?this week$`), 'this_week'],
	[new RegExp(`^${WHAT} (?:on )?(?:for )?this week$`), 'this_week'],
	[new RegExp(`^(?:${WHAT} |${SHOW} )?(?:my )?this week'?s ${WORKOUT}$`), 'this_week'],
	[new RegExp(`^${SHOW} (?:my |the )?${WORKOUT} (?:for )?this week$`), 'this_week'],
	[/^what does (?:my |this )?week look like$/, 'this_week'],
	[/^what (?:am i doing|do i have|have i got) this week$/, 'this_week'],
	[new RegExp(`^(?:${WHAT}|when's|whens|when is) (?:my |the )?next ${WORKOUT}$`), 'next_session'],
	[new RegExp(`^${SHOW} (?:my |the )?next ${WORKOUT}$`), 'next_session'],
	[new RegExp(`^${WHAT} next on (?:my |the )?(?:plan|schedule)$`), 'next_session'],
	[/^when (?:do|am) i (?:train|training|lift|lifting|run|running) next$/, 'next_session']
];

/** Lower case, straight apostrophes, single spaces, no greeting, 'coach', 'please' or end mark. */
function normalise(text: string): string {
	let s = text.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();
	for (let pass = 0; pass < 3; pass += 1) {
		s = s
			.replace(/[\s?.!]+$/, '')
			.replace(/^(?:hey|hi|hello|ok|okay|so|quick question)(?: coach)?[,:]? /, '')
			.replace(/^coach[,:]? /, '')
			.replace(/^please,? /, '')
			.replace(/,? (?:coach|please)$/, '')
			.trim();
	}
	return s;
}

/** The lookup the whole message asks for, or null when it asks anything else. */
export function directIntent(text: string): DirectIntent | null {
	if (text.length > MAX_LOOKUP_CHARS) return null;
	const s = normalise(text);
	for (const [pattern, intent] of PATTERNS) if (pattern.test(s)) return intent;
	return null;
}
