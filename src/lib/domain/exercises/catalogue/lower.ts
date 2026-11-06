/**
 * Catalogue part 1 (m3/05): squat, hinge, lunge and single-leg work, Olympic lifts and pulls,
 * plyometrics, lower-body machines and isolation, conditioning and lower-body mobility.
 * Columns: ../format.ts.
 *
 * How this part is written:
 * - Every member of a group shares its pattern and its measure, so a swap within a group keeps
 *   the training intent and the prescription still reads (sets × reps stays sets × reps).
 * - Single-leg knee-dominant work (split squats, lunges, step-ups, pistols) is the lunge pattern.
 *   Single-leg hinges stay hinges.
 * - Equipment lists everything required. Olympic lifts need only a barbell: a platform helps but
 *   is not required, so a gym without one still gets them. Nordics and sliding curls need only
 *   something to anchor the feet or slide on.
 * - 'Squat', 'Clean', 'Jerk' and 'Lunge' alone name the most common form (back squat, squat
 *   clean, split jerk, forward lunge), so M2's free text links to one entry.
 * - high_impact marks hard landings: a box jump lands on the box, so it is not tagged; a depth
 *   jump is.
 * - seconds is one bout or one hold; a unilateral entry's seconds and reps are per side.
 * - Mobility and conditioning are measured in time or distance, never reps.
 */
import { parseTable } from '../format.ts';
import type { SubstitutionGroups } from '../format.ts';

/** This part's substitution groups: key → the training intent every member preserves. */
export const groups: SubstitutionGroups = {
	knee_dominant_bilateral:
		'Both legs bend at the knee and hip together to train the quads and glutes, as a squat does.',
	hip_hinge_bilateral:
		'A loaded hip hinge on both legs for the hamstrings, glutes and back extensors.',
	hip_hinge_ballistic: 'A fast, swung hip hinge for explosive hip extension and conditioning.',
	hip_extension: 'Hip extension for the glutes and hamstrings with no bar on the back.',
	single_leg_hinge: 'A hip hinge on one leg for the hamstrings and glutes, with balance.',
	single_leg_knee: 'Knee-dominant work on one leg at a time for the quads, glutes and balance.',
	single_leg_lateral: 'Single-leg work out to the side for the adductors, glutes and quads.',
	knee_flexion: 'Bending the knee against resistance to isolate the hamstrings.',
	knee_extension: 'Straightening the knee against resistance to isolate the quads.',
	calf_raise: 'Rising onto the toes against resistance to train the calves.',
	hip_adduction: 'Squeezing the legs together against resistance to strengthen the groin.',
	hip_abduction: 'Pushing the leg out to the side to strengthen the side of the glutes.',
	olympic_snatch: 'An explosive pull from the floor or the hang, caught overhead in one movement.',
	olympic_clean: 'An explosive pull from the floor or the hang, caught on the shoulders.',
	olympic_clean_and_jerk:
		'A clean to the shoulders, then a jerk overhead: the whole two-part lift.',
	olympic_jerk: 'Driving the bar from the shoulders to overhead with the legs, then locking out.',
	olympic_pull: 'A fast pull to full hip and knee extension with no catch, for the Olympic pull.',
	vertical_jump: 'Jumping off both legs for height, to build vertical power.',
	horizontal_jump: 'Jumping for distance, forward or to the side, to build horizontal power.',
	elastic_jump: 'Quick, stiff hops with short ground contacts, for springy calves and ankles.',
	cyclical_conditioning: 'Steady or interval work on a cardio machine, easy on the joints.',
	bodyweight_conditioning: 'Whole-body bodyweight movements done for time, to train anywhere.',
	sled_work: 'Pushing or dragging a loaded sled for leg drive and conditioning, with no impact.',
	striking_conditioning: 'Rounds of punches and kicks for fight-specific conditioning.',
	hip_mobility: 'Rotation and deep-bend range for the hips.',
	hip_flexor_mobility:
		'Opening the front of the hip and thigh, tight from sitting, running or kicking.',
	adductor_mobility: 'Range for the inner thigh, for wide stances and kicks.',
	ankle_mobility: 'Ankle bend and calf length, for squat depth and running.',
	hamstring_mobility: 'Range for the back of the thigh, for hinges, sprinting and high kicks.'
};

export const exercises = parseTable(
	'src/lib/domain/exercises/catalogue/lower.ts',
	`
key | name | aliases | pattern | primary | secondary | equipment | group | skill | reps | seconds | uni | measure/load | tags | disciplines | lift

back_squat | Back squat | Squat, Barbell squat, High-bar squat, Low-bar squat | squat | quads, glutes | adductors, lower_back | barbell, squat_rack | knee_dominant_bilateral | beginner | 3-8 | - | - | reps/external | compound, competition, spinal_loading, deep_knee_flexion | powerlifting, weightlifting, strength, hypertrophy, athletic | back_squat
front_squat | Front squat | Barbell front squat | squat | quads, glutes | upper_back, abs, adductors | barbell, squat_rack | knee_dominant_bilateral | intermediate | 3-8 | - | - | reps/external | compound, spinal_loading, deep_knee_flexion, wrist_loading | weightlifting, strength, hypertrophy, athletic | front_squat
box_squat | Box squat | - | squat | glutes, quads | hamstrings, adductors, lower_back | barbell, squat_rack, bench | knee_dominant_bilateral | beginner | 3-6 | - | - | reps/external | compound, spinal_loading, knee_friendly | powerlifting, strength | -
safety_bar_squat | Safety bar squat | SSB squat, Safety squat bar squat | squat | quads, glutes | upper_back, adductors | specialty_bars, squat_rack | knee_dominant_bilateral | beginner | 4-10 | - | - | reps/external | compound, spinal_loading, deep_knee_flexion, shoulder_friendly | powerlifting, strength, athletic | -
goblet_squat | Goblet squat | Dumbbell goblet squat | squat | quads, glutes | adductors, abs | dumbbells | knee_dominant_bilateral | beginner | 8-15 | - | - | reps/external | compound, deep_knee_flexion, back_friendly | strength, hypertrophy, athletic | -
dumbbell_front_squat | Dumbbell front squat | DB front squat | squat | quads, glutes | abs, upper_back | dumbbells | knee_dominant_bilateral | beginner | 8-12 | - | - | reps/external | compound, deep_knee_flexion | strength, hypertrophy, athletic | -
kettlebell_front_squat | Kettlebell front squat | Double kettlebell front squat, KB front squat | squat | quads, glutes | abs, upper_back | kettlebells | knee_dominant_bilateral | beginner | 6-12 | - | - | reps/external | compound, deep_knee_flexion | strength, athletic | -
leg_press | Leg press | 45-degree leg press, Machine leg press | squat | quads, glutes | adductors | machines | knee_dominant_bilateral | beginner | 8-15 | - | - | reps/external | compound, back_friendly | hypertrophy, strength | -
hack_squat | Hack squat | Machine hack squat | squat | quads | glutes, adductors | machines | knee_dominant_bilateral | beginner | 6-12 | - | - | reps/external | compound, deep_knee_flexion | hypertrophy | -
belt_squat | Belt squat | - | squat | quads, glutes | adductors | machines | knee_dominant_bilateral | beginner | 8-15 | - | - | reps/external | compound, back_friendly, shoulder_friendly | powerlifting, strength, hypertrophy | -
smith_machine_squat | Smith machine squat | Smith squat | squat | quads, glutes | adductors | machines | knee_dominant_bilateral | beginner | 6-12 | - | - | reps/external | compound, spinal_loading | hypertrophy | -
bodyweight_squat | Bodyweight squat | Air squat | squat | quads, glutes | adductors | - | knee_dominant_bilateral | beginner | 15-25 | - | - | reps/bodyweight | deep_knee_flexion | athletic, muay_thai, running | -

deadlift | Deadlift | Conventional deadlift, Barbell deadlift | hinge | glutes, hamstrings, lower_back | quads, upper_back, traps, forearms | barbell | hip_hinge_bilateral | beginner | 3-6 | - | - | reps/external | compound, competition, spinal_loading, grip_demanding | powerlifting, strength, athletic | deadlift
sumo_deadlift | Sumo deadlift | - | hinge | glutes, quads, adductors | hamstrings, lower_back, upper_back, forearms | barbell | hip_hinge_bilateral | intermediate | 3-6 | - | - | reps/external | compound, spinal_loading, grip_demanding | powerlifting, strength | -
trap_bar_deadlift | Trap bar deadlift | Hex bar deadlift | hinge | glutes, quads, hamstrings | lower_back, traps, forearms | specialty_bars | hip_hinge_bilateral | beginner | 3-8 | - | - | reps/external | compound, spinal_loading, grip_demanding | strength, athletic, muay_thai | -
romanian_deadlift | Romanian deadlift | RDL, Barbell RDL | hinge | hamstrings, glutes | lower_back, forearms | barbell | hip_hinge_bilateral | beginner | 6-10 | - | - | reps/external | compound, spinal_loading, grip_demanding | strength, hypertrophy, weightlifting, athletic | -
dumbbell_romanian_deadlift | Dumbbell Romanian deadlift | Dumbbell RDL, DB RDL | hinge | hamstrings, glutes | lower_back, forearms | dumbbells | hip_hinge_bilateral | beginner | 8-12 | - | - | reps/external | compound | strength, hypertrophy, athletic, running, distance_running | -
kettlebell_deadlift | Kettlebell deadlift | KB deadlift | hinge | glutes, hamstrings | quads, lower_back | kettlebells | hip_hinge_bilateral | beginner | 8-15 | - | - | reps/external | compound | strength, athletic | -
good_morning | Good morning | Barbell good morning | hinge | hamstrings, lower_back | glutes | barbell, squat_rack | hip_hinge_bilateral | intermediate | 6-10 | - | - | reps/external | compound, spinal_loading | powerlifting, strength | -

kettlebell_swing | Kettlebell swing | KB swing, Russian kettlebell swing, Two-hand kettlebell swing | hinge | glutes, hamstrings | lower_back, abs, forearms | kettlebells | hip_hinge_ballistic | beginner | 10-20 | - | - | reps/external | explosive | athletic, muay_thai, strength | -
single_arm_kettlebell_swing | Single-arm kettlebell swing | One-arm kettlebell swing, Single-arm KB swing | hinge | glutes, hamstrings | lower_back, obliques, forearms | kettlebells | hip_hinge_ballistic | intermediate | 8-15 | - | y | reps/external | explosive, grip_demanding | athletic, muay_thai | -
dumbbell_swing | Dumbbell swing | DB swing | hinge | glutes, hamstrings | lower_back, forearms | dumbbells | hip_hinge_ballistic | beginner | 10-15 | - | - | reps/external | explosive | athletic | -

hip_thrust | Hip thrust | Barbell hip thrust | hinge | glutes | hamstrings, adductors | barbell, bench | hip_extension | beginner | 6-12 | - | - | reps/external | back_friendly, knee_friendly | hypertrophy, strength, athletic, running | -
glute_bridge | Glute bridge | Hip bridge, Bodyweight glute bridge | hinge | glutes | hamstrings | - | hip_extension | beginner | 12-20 | - | - | reps/bodyweight | back_friendly, knee_friendly | hypertrophy, running, distance_running | -
single_leg_glute_bridge | Single-leg glute bridge | Single-leg hip bridge | hinge | glutes | hamstrings | - | hip_extension | beginner | 10-15 | - | y | reps/bodyweight | back_friendly, knee_friendly | running, distance_running, athletic | -
cable_pull_through | Cable pull-through | Pull-through | hinge | glutes, hamstrings | lower_back | cables | hip_extension | beginner | 10-15 | - | - | reps/external | back_friendly | hypertrophy, strength | -
back_extension | Back extension | 45-degree back extension, Hyperextension | hinge | lower_back, glutes | hamstrings | machines | hip_extension | beginner | 10-15 | - | - | reps/bodyweight | - | powerlifting, strength, hypertrophy | -

single_leg_romanian_deadlift | Single-leg Romanian deadlift | Single-leg RDL, SL RDL, Dumbbell single-leg RDL | hinge | hamstrings, glutes | adductors, lower_back | dumbbells | single_leg_hinge | beginner | 8-12 | - | y | reps/external | - | running, distance_running, athletic, muay_thai | -
kickstand_romanian_deadlift | Kickstand Romanian deadlift | Kickstand RDL, B-stance RDL | hinge | hamstrings, glutes | lower_back | dumbbells | single_leg_hinge | beginner | 8-12 | - | y | reps/external | - | hypertrophy, athletic, running | -

bulgarian_split_squat | Bulgarian split squat | Rear-foot-elevated split squat, RFESS, Dumbbell Bulgarian split squat | lunge | quads, glutes | adductors, hamstrings | dumbbells, bench | single_leg_knee | beginner | 6-12 | - | y | reps/external | compound, back_friendly | strength, hypertrophy, athletic, running, distance_running, muay_thai | -
split_squat | Split squat | Dumbbell split squat, DB split squat | lunge | quads, glutes | adductors | dumbbells | single_leg_knee | beginner | 8-12 | - | y | reps/external | compound, back_friendly | strength, hypertrophy, athletic, running | -
reverse_lunge | Reverse lunge | Dumbbell reverse lunge, Rear lunge | lunge | glutes, quads | adductors, hamstrings | dumbbells | single_leg_knee | beginner | 8-12 | - | y | reps/external | compound, knee_friendly | strength, hypertrophy, athletic, running, muay_thai | -
walking_lunge | Walking lunge | Dumbbell walking lunge | lunge | quads, glutes | adductors, hamstrings | dumbbells | single_leg_knee | beginner | 8-12 | - | y | reps/external | compound | hypertrophy, athletic | -
forward_lunge | Forward lunge | Lunge, Bodyweight lunge | lunge | quads, glutes | adductors | - | single_leg_knee | beginner | 10-15 | - | y | reps/bodyweight | - | athletic, running, muay_thai | -
step_up | Step-up | Dumbbell step-up, Box step-up | lunge | quads, glutes | hamstrings | dumbbells, bench | single_leg_knee | beginner | 8-12 | - | y | reps/external | compound | athletic, running, distance_running | -
pistol_squat | Pistol squat | Pistol, Single-leg squat | lunge | quads, glutes | adductors, abs | - | single_leg_knee | advanced | 3-8 | - | y | reps/bodyweight | deep_knee_flexion | athletic, muay_thai | -

lateral_lunge | Lateral lunge | Side lunge | lunge | quads, glutes, adductors | hamstrings | - | single_leg_lateral | beginner | 8-12 | - | y | reps/bodyweight | - | athletic, muay_thai, running | -
cossack_squat | Cossack squat | - | lunge | adductors, quads, glutes | hamstrings | - | single_leg_lateral | intermediate | 6-10 | - | y | reps/bodyweight | deep_knee_flexion | athletic, muay_thai, weightlifting | -

lying_leg_curl | Lying leg curl | Leg curl, Hamstring curl, Prone leg curl | isolation | hamstrings | calves | machines | knee_flexion | beginner | 8-15 | - | - | reps/external | - | hypertrophy, strength | -
seated_leg_curl | Seated leg curl | - | isolation | hamstrings | calves | machines | knee_flexion | beginner | 8-15 | - | - | reps/external | - | hypertrophy | -
nordic_curl | Nordic curl | Nordic hamstring curl, Nordics | isolation | hamstrings | glutes | - | knee_flexion | intermediate | 3-6 | - | - | reps/bodyweight | - | running, distance_running, athletic, muay_thai | -
sliding_leg_curl | Sliding leg curl | Slider leg curl, Towel leg curl | isolation | hamstrings | glutes | - | knee_flexion | beginner | 8-12 | - | - | reps/bodyweight | - | running, athletic | -

leg_extension | Leg extension | Quad extension, Machine leg extension | isolation | quads | - | machines | knee_extension | beginner | 10-15 | - | - | reps/external | - | hypertrophy | -
sissy_squat | Sissy squat | - | isolation | quads | hip_flexors | - | knee_extension | intermediate | 8-15 | - | - | reps/bodyweight | deep_knee_flexion | hypertrophy | -
reverse_nordic | Reverse Nordic | Reverse Nordic curl | isolation | quads | hip_flexors | - | knee_extension | intermediate | 6-10 | - | - | reps/bodyweight | deep_knee_flexion | hypertrophy, muay_thai, running | -

standing_calf_raise | Standing calf raise | Calf raise, Machine calf raise | isolation | calves | - | machines | calf_raise | beginner | 8-15 | - | - | reps/external | - | hypertrophy, running, distance_running | -
seated_calf_raise | Seated calf raise | - | isolation | calves | - | machines | calf_raise | beginner | 10-20 | - | - | reps/external | - | hypertrophy, running, distance_running | -
single_leg_calf_raise | Single-leg calf raise | One-leg calf raise | isolation | calves | - | - | calf_raise | beginner | 10-20 | - | y | reps/bodyweight | - | running, distance_running, muay_thai | -

machine_hip_adduction | Machine hip adduction | Hip adduction, Adductor machine | isolation | adductors | - | machines | hip_adduction | beginner | 10-15 | - | - | reps/external | - | hypertrophy | -
copenhagen_adduction | Copenhagen adduction | Copenhagen plank, Copenhagen | isolation | adductors | obliques | bench | hip_adduction | intermediate | 6-12 | - | y | reps/bodyweight | - | running, distance_running, muay_thai, athletic | -
machine_hip_abduction | Machine hip abduction | Hip abduction, Abductor machine | isolation | glutes | - | machines | hip_abduction | beginner | 12-20 | - | - | reps/external | - | hypertrophy | -
banded_lateral_walk | Banded lateral walk | Band walk, Lateral band walk, Monster walk | isolation | glutes | - | bands | hip_abduction | beginner | 10-20 | - | - | reps/none | - | running, distance_running, athletic | -

snatch | Snatch | Squat snatch, Full snatch | olympic | glutes, hamstrings, quads | traps, upper_back, front_delts, triceps | barbell | olympic_snatch | advanced | 1-3 | - | - | reps/external | compound, explosive, technical, competition, overhead, deep_knee_flexion, spinal_loading | weightlifting | snatch
power_snatch | Power snatch | - | olympic | glutes, hamstrings, quads | traps, upper_back, front_delts, triceps | barbell | olympic_snatch | advanced | 1-3 | - | - | reps/external | compound, explosive, technical, overhead, spinal_loading | weightlifting, athletic | -
hang_power_snatch | Hang power snatch | - | olympic | glutes, hamstrings, quads | traps, upper_back, front_delts, triceps | barbell | olympic_snatch | intermediate | 2-4 | - | - | reps/external | compound, explosive, technical, overhead, spinal_loading | weightlifting, athletic | -
dumbbell_snatch | Dumbbell snatch | Single-arm dumbbell snatch, DB snatch | olympic | glutes, hamstrings, quads | traps, front_delts, triceps, obliques | dumbbells | olympic_snatch | intermediate | 3-6 | - | y | reps/external | compound, explosive, overhead | athletic, muay_thai | -
clean_and_jerk | Clean & jerk | C&J | olympic | glutes, hamstrings, quads | traps, upper_back, front_delts, triceps | barbell | olympic_clean_and_jerk | advanced | 1-3 | - | - | reps/external | compound, explosive, technical, competition, overhead, spinal_loading, deep_knee_flexion, wrist_loading | weightlifting | clean_and_jerk
power_clean_and_jerk | Power clean & jerk | - | olympic | glutes, hamstrings, quads | traps, upper_back, front_delts, triceps | barbell | olympic_clean_and_jerk | intermediate | 1-3 | - | - | reps/external | compound, explosive, technical, overhead, spinal_loading, wrist_loading | weightlifting, athletic | -
squat_clean | Squat clean | Clean, Full clean | olympic | glutes, hamstrings, quads | traps, upper_back, abs | barbell | olympic_clean | advanced | 1-3 | - | - | reps/external | compound, explosive, technical, deep_knee_flexion, wrist_loading, spinal_loading | weightlifting | -
power_clean | Power clean | - | olympic | glutes, hamstrings, quads | traps, upper_back | barbell | olympic_clean | intermediate | 1-5 | - | - | reps/external | compound, explosive, technical, wrist_loading, spinal_loading | weightlifting, strength, athletic | power_clean
hang_power_clean | Hang power clean | HPC | olympic | glutes, hamstrings, quads | traps, upper_back | barbell | olympic_clean | intermediate | 2-5 | - | - | reps/external | compound, explosive, technical, wrist_loading, spinal_loading | weightlifting, athletic, muay_thai | -
dumbbell_hang_clean | Dumbbell hang clean | DB hang clean | olympic | glutes, hamstrings, quads | traps, upper_back | dumbbells | olympic_clean | intermediate | 3-6 | - | - | reps/external | compound, explosive | athletic | -
push_jerk | Push jerk | - | olympic | quads, front_delts, triceps | glutes, upper_back | barbell, squat_rack | olympic_jerk | intermediate | 1-3 | - | - | reps/external | compound, explosive, technical, overhead, spinal_loading | weightlifting, athletic | -
split_jerk | Split jerk | Jerk | olympic | quads, front_delts, triceps | glutes, upper_back | barbell, squat_rack | olympic_jerk | advanced | 1-3 | - | - | reps/external | compound, explosive, technical, overhead, spinal_loading | weightlifting | -
clean_pull | Clean pull | - | olympic | glutes, hamstrings, traps | quads, lower_back, upper_back, forearms | barbell | olympic_pull | intermediate | 2-5 | - | - | reps/external | compound, explosive, spinal_loading, grip_demanding | weightlifting | -
snatch_pull | Snatch pull | - | olympic | glutes, hamstrings, traps | quads, lower_back, upper_back, forearms | barbell | olympic_pull | intermediate | 2-5 | - | - | reps/external | compound, explosive, spinal_loading, grip_demanding | weightlifting | -

box_jump | Box jump | - | plyometric | quads, glutes | calves, hamstrings | plyo_box | vertical_jump | beginner | 3-5 | - | - | reps/bodyweight | explosive | athletic, muay_thai, running | -
squat_jump | Squat jump | Jump squat | plyometric | quads, glutes | calves, hamstrings | - | vertical_jump | beginner | 3-6 | - | - | reps/bodyweight | explosive, high_impact | athletic, muay_thai | -
tuck_jump | Tuck jump | - | plyometric | quads, glutes | calves, hip_flexors, abs | - | vertical_jump | intermediate | 3-6 | - | - | reps/bodyweight | explosive, high_impact | athletic, muay_thai | -
depth_jump | Depth jump | Drop jump | plyometric | quads, glutes | calves, hamstrings | plyo_box | vertical_jump | advanced | 3-5 | - | - | reps/bodyweight | explosive, high_impact | athletic | -
broad_jump | Broad jump | Standing long jump | plyometric | glutes, quads | hamstrings, calves | - | horizontal_jump | beginner | 3-5 | - | - | reps/bodyweight | explosive, high_impact | athletic, running, muay_thai | -
bounding | Bounding | Bounds | plyometric | glutes, calves | quads, hamstrings, hip_flexors | - | horizontal_jump | intermediate | 6-10 | - | y | reps/bodyweight | explosive, high_impact | running, distance_running, athletic | -
skater_jump | Skater jump | Lateral bound, Skaters | plyometric | glutes, quads | adductors, calves | - | horizontal_jump | beginner | 5-8 | - | y | reps/bodyweight | explosive, high_impact | athletic, muay_thai, running | -
pogo_hop | Pogo hop | Pogo jump, Ankle hop | plyometric | calves | quads | - | elastic_jump | beginner | 10-20 | - | - | reps/bodyweight | explosive, high_impact | running, distance_running, muay_thai | -
single_leg_pogo_hop | Single-leg pogo hop | Single-leg hop | plyometric | calves | quads | - | elastic_jump | intermediate | 8-15 | - | y | reps/bodyweight | explosive, high_impact | running, distance_running, muay_thai | -

rowing_machine | Rowing machine | Rower, Rowing erg, Indoor rowing | conditioning | quads, upper_back | glutes, hamstrings, lats, biceps | rower | cyclical_conditioning | beginner | - | 600 | - | time/none | low_impact | athletic, muay_thai, running | -
air_bike | Air bike | Assault bike, Echo bike, Fan bike | conditioning | quads | glutes, hamstrings, chest, upper_back | bike | cyclical_conditioning | beginner | - | 600 | - | time/none | low_impact | athletic, muay_thai | -
stationary_bike | Stationary bike | Spin bike, Exercise bike, Indoor cycling | conditioning | quads | glutes, hamstrings, calves | bike | cyclical_conditioning | beginner | - | 900 | - | time/none | low_impact | running, distance_running, athletic, hypertrophy | -
ski_erg | SkiErg | - | conditioning | lats | triceps, abs, glutes | ski_erg | cyclical_conditioning | beginner | - | 600 | - | time/none | low_impact | athletic, muay_thai | -
incline_treadmill_walk | Incline treadmill walk | Incline walk, Treadmill incline walk | conditioning | glutes, calves | hamstrings, quads | treadmill | cyclical_conditioning | beginner | - | 1200 | - | time/none | low_impact | strength, hypertrophy, athletic | -
burpee | Burpee | - | conditioning | quads, chest | front_delts, triceps, abs, glutes | - | bodyweight_conditioning | beginner | - | 30 | - | time/bodyweight | high_impact, wrist_loading | athletic, muay_thai | -
mountain_climber | Mountain climber | - | conditioning | abs, hip_flexors | front_delts, quads | - | bodyweight_conditioning | beginner | - | 30 | - | time/bodyweight | wrist_loading | athletic, muay_thai | -
jumping_jack | Jumping jack | Star jump | conditioning | calves | glutes, side_delts | - | bodyweight_conditioning | beginner | - | 60 | - | time/bodyweight | high_impact | athletic, muay_thai | -
bear_crawl | Bear crawl | - | conditioning | abs, front_delts | quads, triceps | - | bodyweight_conditioning | beginner | - | 30 | - | time/bodyweight | wrist_loading | athletic, muay_thai | -
sled_push | Sled push | Prowler push, Prowler | conditioning | quads, glutes | calves, triceps | sled | sled_work | beginner | - | - | - | distance/external | low_impact | strength, athletic, muay_thai | -
sled_drag | Backward sled drag | Reverse sled drag, Sled drag | conditioning | quads | calves, glutes | sled | sled_work | beginner | - | - | - | distance/external | low_impact, knee_friendly | strength, athletic, running | -
heavy_bag_rounds | Heavy bag rounds | Heavy bag, Bag work, Bag rounds | conditioning | obliques, front_delts | hip_flexors, calves, triceps | heavy_bag | striking_conditioning | beginner | - | 180 | - | time/none | - | muay_thai, athletic | -
shadow_boxing | Shadow boxing | - | conditioning | obliques, front_delts | hip_flexors, calves | - | striking_conditioning | beginner | - | 180 | - | time/none | - | muay_thai, athletic | -

hip_90_90_switch | 90/90 hip switch | Hip switch, 90/90 stretch | mobility | glutes | hip_flexors, adductors | - | hip_mobility | beginner | - | 60 | - | time/none | - | muay_thai, running, weightlifting, athletic | -
pigeon_stretch | Pigeon stretch | Pigeon pose | mobility | glutes | hip_flexors | - | hip_mobility | beginner | - | 60 | y | time/none | - | running, distance_running, muay_thai | -
deep_squat_hold | Deep squat hold | Squat hold, Deep squat sit | mobility | adductors, glutes | calves, lower_back | - | hip_mobility | beginner | - | 60 | - | time/none | deep_knee_flexion | weightlifting, athletic, muay_thai | -
half_kneeling_hip_flexor_stretch | Half-kneeling hip flexor stretch | Hip flexor stretch, Kneeling hip flexor stretch | mobility | hip_flexors | quads | - | hip_flexor_mobility | beginner | - | 45 | y | time/none | - | running, distance_running, muay_thai, strength | -
couch_stretch | Couch stretch | - | mobility | quads, hip_flexors | - | - | hip_flexor_mobility | beginner | - | 60 | y | time/none | deep_knee_flexion | running, distance_running, muay_thai, weightlifting | -
worlds_greatest_stretch | World's greatest stretch | WGS | mobility | hip_flexors, hamstrings | glutes, upper_back | - | hip_flexor_mobility | beginner | - | 60 | y | time/none | - | athletic, running, muay_thai | -
frog_stretch | Frog stretch | - | mobility | adductors | - | - | adductor_mobility | beginner | - | 60 | - | time/none | - | muay_thai, weightlifting | -
adductor_rock_back | Adductor rock-back | Half-kneeling adductor rock-back | mobility | adductors | hamstrings | - | adductor_mobility | beginner | - | 45 | y | time/none | - | muay_thai, athletic, running | -
knee_to_wall_ankle_stretch | Knee-to-wall ankle stretch | Knee-to-wall, Knee-to-wall ankle mobilisation | mobility | calves | - | - | ankle_mobility | beginner | - | 45 | y | time/none | - | running, distance_running, weightlifting | -
wall_calf_stretch | Wall calf stretch | Calf stretch | mobility | calves | - | - | ankle_mobility | beginner | - | 45 | y | time/none | - | running, distance_running | -
supine_hamstring_stretch | Supine hamstring stretch | Hamstring stretch, Lying hamstring stretch | mobility | hamstrings | calves | - | hamstring_mobility | beginner | - | 45 | y | time/none | - | running, distance_running, muay_thai | -
leg_swing | Leg swing | Front-to-back leg swing | mobility | hamstrings, hip_flexors | adductors, glutes | - | hamstring_mobility | beginner | - | 30 | y | time/none | - | running, muay_thai, athletic | -
`
);
