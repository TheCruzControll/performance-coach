/**
 * The sign-in email (ADR 0011). Pure: the text depends only on the link (unit-tested in
 * email-link-message.test.ts).
 *
 * Plain text only: no HTML, images or tracking, and no name or address, so the message says
 * nothing about the owner to anyone who sees it. The link appears exactly once and is the only
 * URL, so a mail client has one thing to open.
 */
import type { MailMessage } from '../mail';

export const EMAIL_LINK_SUBJECT = 'Your Performance Coach sign-in link';

export function emailLinkMessage(link: string): Pick<MailMessage, 'subject' | 'text'> {
	return {
		subject: EMAIL_LINK_SUBJECT,
		text: [
			'Open this link to sign in to Performance Coach, then tap Sign in:',
			'',
			link,
			'',
			'It works once, for 15 minutes, and replaces any earlier link.',
			'',
			"Didn't ask for this? Ignore this email: nothing happens unless the link is opened and Sign in is tapped.",
			'',
			"Don't forward it: anyone who opens it can sign in as you.",
			''
		].join('\n')
	};
}
