/**
 * Every word of the in-workout quick actions (PRD §8; the brief's substitution rules): the actions
 * sheet, the alternatives, the dislike confirmation, the slot states and the pain flow. They live
 * in one module so the safety-relevant wording is reviewed in one place, and copy.test.ts scans
 * every string here, written or rendered: none suggests carrying on through pain, none names a
 * diagnosis, and the pain copy points to Profile → Injuries and to a professional.
 *
 * substitution.ts holds the rules these words describe.
 */
import { EQUIPMENT_LABEL } from '../profile/catalog.ts';
import type { BodyArea, Equipment, Severity } from '../profile/catalog.ts';
import type { QuickAction } from './substitution.ts';
import type { SlotState } from './types.ts';

/** A choice's label, and the line under it. */
export interface ChoiceWords {
	label: string;
	detail: string;
}

export const QUICK_ACTION_COPY: Record<QuickAction, ChoiceWords> = {
	machine_unavailable: { label: 'Machine unavailable', detail: 'Swap it for this session only' },
	suggest_alternative: {
		label: 'Suggest an alternative',
		detail: 'Exercises that train the same thing'
	},
	dislike: { label: "I don't like this exercise", detail: 'Swap it, and stop it being prescribed' },
	pain: { label: 'This hurts', detail: 'Stop, or switch to something gentler' },
	skip: { label: 'Skip exercise', detail: 'Its remaining sets are marked as skipped' }
};

/** The alternatives list, by the action that opened it, and its state when nothing fits. */
export const ALTERNATIVES_COPY = {
	machine_unavailable: {
		title: 'Swap for this session',
		note: 'Just for today: your plan stays the same.'
	},
	suggest_alternative: { title: 'Alternatives', note: 'Each one keeps the purpose of this slot.' },
	dislike: { title: 'Pick a replacement', note: 'You confirm before anything changes.' },
	empty: {
		title: 'Nothing fits right now',
		note: 'No alternative suits your equipment, injuries and preferences.',
		skip: 'Skip exercise'
	}
};

/** What an alternative needs, so the owner sees it before choosing. */
export function needsLine(equipment: readonly Equipment[]): string {
	if (equipment.length === 0) return 'No equipment needed';
	return `Needs ${equipment.map((e) => EQUIPMENT_LABEL[e]).join(', ')}`;
}

/** The explicit confirmation a dislike needs before anything is sent. */
export function dislikeConfirmation(
	names: { exercise: string; replacement: string },
	changesProgram: boolean
) {
	const plan = changesProgram ? ', and your plan uses it from today' : '';
	return {
		title: `Don't prescribe ${names.exercise} again?`,
		body: `Today you'll do ${names.replacement}${plan}. You can change this in Profile → Exercises.`,
		confirm: "Don't prescribe it again",
		cancel: 'Cancel'
	};
}

/** What an exercise card says about its slot; nothing for one as planned. */
export const SLOT_STATE_COPY: Record<SlotState, string | null> = {
	planned: null,
	added: 'Added',
	swapped: 'Swapped for this session',
	wont_prescribe: "Won't be prescribed again",
	skipped: 'Skipped',
	stopped: 'Stopped'
};

// ---- This hurts -----------------------------------------------------------------------------

export const PAIN_COPY = {
	title: 'This hurts',
	intro: 'Stopping is always OK. Where it hurts and how bad are optional.',
	area: { label: 'Where does it hurt?', hint: 'Optional' },
	severity: { label: 'How bad is it?', hint: 'Optional' },
	choices: 'What would you like to do?',
	stop: { label: 'Stop this exercise', detail: 'Its remaining sets are marked as skipped' },
	end: { label: 'End the workout here', detail: 'Save what you did and finish' },
	note: { label: 'Note', hint: 'Optional', placeholder: 'What happened?' },
	injuries: {
		text: 'If it keeps coming back, add it to your injuries so your plan works around it.',
		link: 'Add it to Profile → Injuries'
	},
	professional: 'If the pain is sharp or persists, see a doctor or physiotherapist.',
	save: 'Save'
};

export const SEVERITY_COPY: Record<Severity, ChoiceWords> = {
	mild: { label: 'Mild', detail: 'You notice it' },
	moderate: { label: 'Moderate', detail: 'It changes how you move' },
	severe: { label: 'Severe', detail: 'Sharp, or hard to move' }
};

const AREA_WORDS: Record<BodyArea, string> = {
	neck: 'your neck',
	shoulder: 'your shoulder',
	elbow: 'your elbow',
	wrist_hand: 'your wrist and hand',
	upper_back: 'your upper back',
	lower_back: 'your lower back',
	hip: 'your hip',
	groin: 'your groin',
	hamstring: 'your hamstring',
	knee: 'your knee',
	shin_calf: 'your shin and calf',
	ankle_foot: 'your ankle and foot',
	other: 'that area'
};

/** The heading over the gentler options for an area. */
export function gentlerHeading(area: BodyArea): string {
	return `Gentler on ${AREA_WORDS[area]}`;
}

/** Said in their place when the kit has no gentler option for the area. */
export function noGentler(area: BodyArea): string {
	return `Nothing gentler on ${AREA_WORDS[area]} today, so stopping is the safe choice.`;
}
