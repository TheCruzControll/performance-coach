/**
 * The paces rules (m7/08 training-paces): how a race becomes a VDOT, which race counts, the
 * training paces and the segment kinds that run at them, and heart-rate zones.
 */
import {
	DANIELS_GILBERT,
	EASY_PACE_SHARE,
	HR_LIMITS,
	HR_METHODS,
	HR_ZONE_BANDS,
	PACE_LIMITS,
	RECENCY,
	SEGMENT_PACES,
	SEGMENT_ZONES,
	TRAINING_INTENSITIES,
	VDOT_DISTANCES
} from '../paces.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/rules/paces.ts';

export const rules: readonly RuleDefinition[] = [
	{
		id: 'paces.vdot',
		kind: 'constant',
		statement:
			'A race sets a VDOT by the Daniels–Gilbert equations: the running cost of its speed over the share of VO2max a race that long is run at.',
		rationale:
			'Daniels’ Running Formula rests on these equations, so one race predicts every other distance and every training pace, published and checked against his tables.',
		source: `${FILE}#DANIELS_GILBERT`,
		values: DANIELS_GILBERT
	},
	{
		id: 'paces.vdot_distances',
		kind: 'constant',
		statement:
			'The equations read races from 1500 m to the marathon; a race outside them is carried to the nearer end by Riegel’s formula first.',
		rationale:
			'Daniels’ tables stop at those distances, and Riegel’s formula is the simpler estimate M3 used, kept only where VDOT has nothing to say.',
		source: `${FILE}#VDOT_DISTANCES`,
		values: VDOT_DISTANCES
	},
	{
		id: 'paces.training_intensities',
		kind: 'constant',
		statement:
			'Easy runs at 59–74 % of VDOT, marathon pace at 75–84 %, threshold at 83–88 %, intervals at 95–100 % and repetitions at 105–110 %.',
		rationale:
			'Daniels’ training intensities: each pace trains one system, and a range rather than one number allows for heat, hills and tired days.',
		source: `${FILE}#TRAINING_INTENSITIES`,
		values: TRAINING_INTENSITIES
	},
	{
		id: 'paces.segment_paces',
		kind: 'constant',
		statement:
			'Easy, long, recovery, warm-up and cool-down running is at easy pace, steady segments at marathon pace, tempo at threshold and intervals at interval pace.',
		rationale:
			'Marathon-pace work runs on the existing steady segment kind, so logging and Progress need no new run type; repetition pace is for the coach only.',
		source: `${FILE}#SEGMENT_PACES`,
		values: SEGMENT_PACES
	},
	{
		id: 'paces.segment_zones',
		kind: 'constant',
		statement:
			'Recovery jogs are in heart-rate zone 1, aerobic running in zone 2, marathon-pace work in 3, threshold in 4 and intervals in 5.',
		rationale:
			'The zones M3’s run segments already carry, so a segment’s pace and its zone describe the same effort.',
		source: `${FILE}#SEGMENT_ZONES`,
		values: SEGMENT_ZONES
	},
	{
		id: 'paces.easy_pace_share',
		kind: 'constant',
		statement:
			'With no race that counts, a told easy pace stands for the middle of the easy range and sets the VDOT every other pace comes from.',
		rationale:
			'An easy pace is what the runner does now, so it is a fair, if rough, guide to the rest; it is always low confidence.',
		source: `${FILE}#EASY_PACE_SHARE`,
		values: EASY_PACE_SHARE
	},
	{
		id: 'paces.limits',
		kind: 'constant',
		statement: 'A pace is never faster than 2:00 or slower than 25:00 per km.',
		rationale:
			'The bounds a planned run segment’s pace may take, so every computed pace is one it can hold.',
		source: `${FILE}#PACE_LIMITS`,
		values: PACE_LIMITS
	},
	{
		id: 'paces.recency',
		kind: 'constant',
		statement:
			'The best race of the last 26 weeks sets the paces; failing one, the best of the last 52 at low confidence; failing that, a race with no date at low confidence; then the told easy pace; then effort alone.',
		rationale:
			'Fitness changes over months, so a recent race is the truest guide; an older or undated race is still better than nothing, but only as a rough one.',
		source: `${FILE}#RECENCY`,
		values: RECENCY
	},
	{
		id: 'paces.hr_methods',
		kind: 'constant',
		statement:
			'Heart-rate zones come from threshold heart rate when given, else from heart-rate reserve (max and resting), else from max alone.',
		rationale:
			'Threshold anchors zones to the runner’s own physiology best, reserve accounts for fitness through the resting rate, and max needs only one number.',
		source: `${FILE}#HR_METHODS`,
		values: HR_METHODS
	},
	{
		id: 'paces.hr_zone_bands',
		kind: 'constant',
		statement:
			'Zones 1 to 5 are Friel’s bands of threshold heart rate, or 10 % steps of heart-rate reserve (Karvonen) or of max from 50 %.',
		rationale:
			'Published methods the owner can check against a watch; with max 190 and resting 50, zone 2 is 134–148 bpm.',
		source: `${FILE}#HR_ZONE_BANDS`,
		values: HR_ZONE_BANDS
	},
	{
		id: 'paces.hr_limits',
		kind: 'constant',
		statement:
			'Heart rates out of range, or out of order (resting below threshold below max), give no zones at all.',
		rationale:
			'Numbers that cannot all be right are not guessed between: the zones wait for correct ones.',
		source: `${FILE}#HR_LIMITS`,
		values: HR_LIMITS
	}
];
