import { describe, expect, it } from 'vitest';
import { EMAIL_LINK_SUBJECT, emailLinkMessage } from './email-link-message';

const TOKEN = 'A'.repeat(21) + '_-' + 'z'.repeat(20);
const LINK = `https://coach.nikocruz.com/?link#t=${TOKEN}`;

describe('emailLinkMessage', () => {
	const { subject, text } = emailLinkMessage(LINK);

	it('has the fixed subject', () => {
		expect(subject).toBe('Your Performance Coach sign-in link');
		expect(subject).toBe(EMAIL_LINK_SUBJECT);
	});

	it('holds the link once, and no other URL', () => {
		expect(text.split(LINK)).toHaveLength(2);
		expect(text.match(/https?:\/\/\S+/g)).toEqual([LINK]);
		// Nothing else a mail client could turn into a link: no scheme, www. or bare domain.
		expect(text.replace(LINK, '')).not.toMatch(/:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\b/i);
	});

	it('says how long it works, how to ignore it and not to forward it', () => {
		expect(text).toContain('works once, for 15 minutes, and replaces any earlier link');
		expect(text).toContain(
			"Didn't ask for this? Ignore this email: nothing happens unless the link is opened and Sign in is tapped."
		);
		expect(text).toContain("Don't forward it");
	});

	it('is plain text with no name or address', () => {
		expect(text).not.toMatch(/<[a-z/!][^>]*>/i);
		expect(text).not.toMatch(/&[a-z]+;/i);
		expect(`${subject}\n${text}`).not.toMatch(/@/);
		expect(`${subject}\n${text}`).not.toMatch(/Niko|Cruz|Hi |Dear /);
		expect(text.split('\n').every((line) => line === line.trimEnd())).toBe(true);
	});
});
