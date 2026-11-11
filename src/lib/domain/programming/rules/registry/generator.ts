/**
 * The generator's rules: the serial generator chain (m7/28 generator-season to m7/33
 * generator-combat) appends to this file, each slice its own entries.
 *
 * generator-season (m7/28): the season, the goal order and modes, and the dose caps, each a
 * behaviour applied by the function its source names.
 *
 * generator-schedule (m7/29): the schedule stage, which repairs every planned week with the week
 * scheduler: the week kinds repaired on their own, the hardest building week whose days the block
 * shares, an eased session's loads, and a goal's session kept over one no goal trains.
 *
 * generator-phasing (m7/30): each week's main lifts by its phase, the accessories peak and taper
 * weeks shed, the dose's top-set cap, and the hard-set band each week is balanced to.
 *
 * generator-running (m7/32): a marathon or half week's runs from its targets, and a running goal
 * that does not lead held to its dose.
 *
 * generator-combat (m7/33): a fight-camp week's Muay Thai, sparring and conditioning from its
 * targets, the room the camp takes, and a Muay Thai goal that does not lead kept to technique and
 * pads.
 */
import { CAMP_CONDITIONING } from '../../other.ts';
import { HALVED_ACCESSORY_PHASES } from '../../stages/phasing.ts';
import { HARDEST_BY, OWN_WEEKS } from '../../stages/schedule.ts';
import type { RuleDefinition } from './types.ts';

const PROGRAMMING = 'src/lib/domain/programming';

export const rules: readonly RuleDefinition[] = [
	{
		id: 'generator.priority_order',
		kind: 'behaviour',
		statement:
			'Before any stage runs, the goals are put in order of their effective priority on the block’s first day, the leader first, and each is marked primary, secondary or held at maintenance.',
		rationale:
			'The day rule, the split and the placement all favour the first goal, so putting the goal that leads now first makes every one of them follow it without changing their own rules.',
		source: `${PROGRAMMING}/stages/prepare.ts#prepare`
	},
	{
		id: 'generator.season_blocks',
		kind: 'behaviour',
		statement:
			'A new program holds the season’s blocks: the first planned week by week, then outlines to each event, with every block type, taper, deload and dose recorded. With every goal paused, it is the maintenance plan as before.',
		rationale:
			'Planning the whole road at once shows where each block leads, and the first block is the only one planned in detail because the rest are planned from your results when they come up.',
		source: `${PROGRAMMING}/stages/blocks.ts#blocks`
	},
	{
		id: 'generator.secondary_split',
		kind: 'behaviour',
		statement:
			'A strength or muscle-building goal training alongside the leader as a secondary goal keeps its own split and style, even when another kind of goal leads.',
		rationale:
			'A secondary goal is still meant to progress, which the maintenance split cannot do; only a goal held at maintenance moves to it.',
		source: `${PROGRAMMING}/splits.ts#chooseSplit`
	},
	{
		id: 'generator.dose_cap',
		kind: 'behaviour',
		statement:
			'A kind of session that only goals held at maintenance want gets no more sessions a week than their dose, and the days it frees go round again, the leader first.',
		rationale:
			'A dose is the least that keeps a goal; giving it more days would take them from the goal that leads now.',
		source: `${PROGRAMMING}/demand.ts#allocateWeek`
	},
	{
		id: 'generator.own_weeks',
		kind: 'constant',
		statement:
			'Deload, taper, event, recovery, maintenance and cutback weeks are repaired on their own, without the days the building weeks share.',
		rationale:
			'Their sessions and load differ from the building weeks’, so the days that suit the hardest week need not suit them.',
		source: `${PROGRAMMING}/stages/schedule.ts#OWN_WEEKS`,
		values: OWN_WEEKS
	},
	{
		id: 'generator.hardest_week',
		kind: 'constant',
		statement:
			'The block’s building weeks share the days the scheduler gives its hardest building week, the one with the most planned load, unless a week costs less repaired as it was placed.',
		rationale:
			'A session keeps its day all block, so the week whose real demands clash most decides the days, and the lighter weeks follow it.',
		source: `${PROGRAMMING}/stages/schedule.ts#HARDEST_BY`,
		values: HARDEST_BY
	},
	{
		id: 'generator.eased_loads',
		kind: 'behaviour',
		statement:
			'A session eased to avoid a clash has each main lift it lowered loaded again at its new target RPE, as the loads and progression rules load a week with that cap, and its length checked again.',
		rationale:
			'An easier session prescribed with its old loads would ask for the old effort; its numbers must match what it now asks.',
		source: `${PROGRAMMING}/stages/schedule.ts#reloaded`
	},
	{
		id: 'generator.kept_over_ungoaled',
		kind: 'behaviour',
		statement:
			'When no repair avoids a clash between a goal’s session and one no goal trains, such as a class you keep without a goal for it, the goal’s session keeps its day and the trade-off is recorded.',
		rationale:
			'Each of your goals ranks above training no goal names, and a trade-off the plan makes is yours to know about.',
		source: `${PROGRAMMING}/stages/schedule.ts#schedule`
	},
	{
		id: 'generator.phase_prescription',
		kind: 'behaviour',
		statement:
			'In a week its strength or hypertrophy block plans, each main lift takes the week’s reps and top-set RPE, its back-off sets a point under, and is loaded from your 1RM at that RPE: a measured one, an estimate a step lower, or a top set by RPE when it is blank.',
		rationale:
			'Each phase asks something different of the main lifts, more reps at moderate effort early and heavy singles to triples at the peak, so the prescription has to change with it.',
		source: `${PROGRAMMING}/stages/phasing.ts#phaseWeek`
	},
	{
		id: 'generator.halved_accessories',
		kind: 'constant',
		statement:
			'Realization and taper weeks keep the main lifts and only the first half of the other exercises, the ones the split fills first.',
		rationale:
			'Peak and taper weeks are for practising the competition lifts heavy while fatigue falls; the rest of the work would only add fatigue.',
		source: `${PROGRAMMING}/stages/phasing.ts#HALVED_ACCESSORY_PHASES`,
		values: HALVED_ACCESSORY_PHASES
	},
	{
		id: 'generator.dose_top_set',
		kind: 'behaviour',
		statement:
			'A strength goal held at maintenance keeps the maintenance split’s prescription, and no main lift’s top set, or the week’s cap, goes above the dose’s RPE.',
		rationale:
			'A dose is the least that keeps strength; a harder top set would cost the goal that leads the recovery it needs.',
		source: `${PROGRAMMING}/stages/phasing.ts#phaseWeek`
	},
	{
		id: 'generator.week_band',
		kind: 'behaviour',
		statement:
			'A week that plans its own hard sets per muscle group is balanced to that range, a rising range week by week from the week before; any other week to the band its goal’s mode gives: the maintenance band, the lower half of its own band when it trains alongside the leader, or its own band when it leads.',
		rationale:
			'The week’s targets are what your reviews judge it by, so the sessions must be built to them, and a goal that does not lead gets only the volume its mode allows.',
		source: `${PROGRAMMING}/stages/volume.ts#balancePhased`
	},
	{
		id: 'generator.block_runs',
		kind: 'behaviour',
		statement:
			'In a marathon or half week planned with its running targets, the long run takes its planned length within the 10 % and share caps and grows at most 1.5 km a week, the phase’s race work fills its quality sessions (marathon pace closing the long run, threshold runs, 10K-pace intervals), and a cutback week holds at most 80 % of the biggest week so far.',
		rationale:
			'The race plan sets each week’s long run and race-specific work, so the sessions are built to it, and the caps that keep every run safe still apply.',
		source: `${PROGRAMMING}/running.ts#planRuns`
	},
	{
		id: 'generator.run_dose',
		kind: 'behaviour',
		statement:
			'A running goal that trains alongside the leader or is held at maintenance runs 65 % of your recent weekly volume every week (less only in a light week), at most one quality session, with the long run never longer than your recent longest.',
		rationale:
			'Aerobic fitness holds on 60–70 % of your recent mileage, so running more would only take recovery from the goal that leads.',
		source: `${PROGRAMMING}/running.ts#planRuns`
	},
	{
		id: 'generator.camp_sessions',
		kind: 'behaviour',
		statement:
			'In a fight-camp week, Muay Thai comes up to the week’s planned sessions with your classes counted, hard sparring up to its planned number with each hard class counted toward it and none in the 7 days before the fight, conditioning in 3-minute rounds when the week plans rounds, and a fight week of technique and light pads only. Your commitments stay as they are.',
		rationale:
			'The camp plans each week’s fight work, so the sessions are built to it; a hard class already hits like sparring, so it counts toward the cap rather than adding to it.',
		source: `${PROGRAMMING}/other.ts#planOther`
	},
	{
		id: 'generator.camp_conditioning',
		kind: 'constant',
		statement:
			'A fight-camp conditioning session is a short warm-up and then the week’s rounds of 3 minutes, at RPE 7, within your session length.',
		rationale: CAMP_CONDITIONING.why,
		source: `${PROGRAMMING}/other.ts#CAMP_CONDITIONING`,
		values: CAMP_CONDITIONING
	},
	{
		id: 'generator.camp_room',
		kind: 'behaviour',
		statement:
			'A fight-camp week fills the days left first; when they run short it takes strength sessions of goals held at maintenance, the lowest-priority first, down to the fewest their dose allows, never a run. Hard sparring and conditioning take the room by turns, then technique and pads.',
		rationale:
			'The fight leads, so its camp gets the days a held goal can spare, while every held goal keeps its dose and the easy runs stay as the recovery between hard days.',
		source: `${PROGRAMMING}/other.ts#CAMP_ORDER`
	},
	{
		id: 'generator.muay_thai_dose',
		kind: 'behaviour',
		statement:
			'A Muay Thai goal that trains alongside the leader or is held at maintenance gets technique and pad work only, with no sparring beyond your classes. With every goal paused, the plan keeps its usual sparring.',
		rationale:
			'Technique and pads keep timing and shape sharp; sparring’s knocks would take recovery from the goal that leads.',
		source: `${PROGRAMMING}/other.ts#planOther`
	}
];

/**
 * M3's block rules that M7 replaces once no generation path reads their constant. None is marked
 * yet: on m7/28, TAPER_LEAD_DAYS is still read by periodisation/fight-camp.ts and rules/taper.ts,
 * FIRST_BLOCK by review/directives.ts (M6's next-block dates) and rules/road.ts, and
 * SHORT_EVENT_WEEKS by blocks.ts planFirstBlock, which the season keeps for a first program and the
 * all-paused plan. The slice that removes the last reader adds the entry here.
 */
export const supersedes: Readonly<Record<string, string>> = {};
