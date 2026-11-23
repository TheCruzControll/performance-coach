/**
 * The resume line's last finding, for a screen that draws the in-progress state itself (Today's
 * hero, v2/06). ResumeBar writes `found`; a screen that shows the active or remote workout sets
 * `claimed` to its pathname while it is mounted, and the line then draws only `waiting` there
 * (resume.ts shownFor). The sync engine runs from `found`, so a claim never stops syncing.
 * `continuing` and `failed` follow 'Continue here' (resume.ts continueHereFlow), wherever it is
 * pressed. $state.raw over the probe's summaries, as the client README's M4 rule asks.
 */
import { NOTHING, type Continuing, type Resume } from './resume.ts';

class ResumeState implements Continuing {
	/** What the line last found, before any claim; NOTHING while the line is not mounted. */
	found = $state.raw<Resume>(NOTHING);
	/** The pathname of the screen that draws the workout in progress itself, or null. */
	claimed = $state<string | null>(null);
	continuing = $state(false);
	failed = $state(false);
}

export const resumeState = new ResumeState();
