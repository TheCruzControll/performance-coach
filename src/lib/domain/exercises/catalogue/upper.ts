/**
 * Catalogue part 2 (m3/06): bench and overhead pressing, push-ups and dips, rows, pull-ups and
 * pulldowns, delts and arms, carries, core and neck work, and upper-body mobility.
 * Columns: ../format.ts.
 *
 * How this part is written. Part 1's rules hold: a group's members share a pattern and a
 * measure, equipment lists everything required, and a unilateral entry's reps, seconds and
 * distance are per side. Then:
 * - A press or a pull names the muscles it is built around as primary and the arm muscle that
 *   helps (triceps or biceps) as secondary, so weekly hard sets count the arm as a helper.
 *   Close-grip and floor presses, dips and chin-ups lean on the arm, so they name it primary.
 * - overhead marks every exercise that presses or holds a load overhead, pullovers and overhead
 *   extensions included. The landmine press drives up and forward instead, so it is tagged
 *   shoulder_friendly, not overhead, and its group is the vertical press for a shoulder that
 *   cannot go overhead. No horizontal push is tagged overhead, so horizontal pressing stays
 *   open, and floor presses, which stop the elbows at the floor, are shoulder_friendly.
 * - Dips press down like a decline bench press, so they are horizontal pushes. They need
 *   parallel bars, which M2 has no key for: they ask for the pull-up bar, as racks, power
 *   towers and parks put the two together.
 * - Face pulls, pull-aparts and reverse flies are horizontal pulls, so they count toward the
 *   push:pull balance. Straight-arm pulldowns and pullovers are vertical pulls for the lats, and
 *   the floor pullover is the one a dumbbells-only gym with no bench can do.
 * - The barbell bench, incline and floor presses need a rack to take the bar from, and the
 *   inverted row one to hold it at hip height. Landmine work needs only a barbell, as a corner
 *   can hold its end. The lat pulldown is a cable station's high pulley. The weighted pull-up
 *   hangs a dumbbell from a belt or between the feet. Incline and handstand push-ups need only
 *   a ledge or a wall. M2 has no ab-wheel key, so the rollout takes a barbell.
 * - Side planks and Pallof work are anti-rotation, as the vocabulary has no anti-lateral-flexion
 *   pattern. Rotation and anti-rotation work one side at a time, so they are unilateral.
 *   Carries are measured in distance, like sled work; holds and mobility in time.
 * - Neck work is isolation for Muay Thai: the head is the load, and a plate on a towel adds to
 *   it. The rotator cuff has no muscle key, so external rotations credit the rear delts.
 * - Generic names ('Bench', 'Shrug', 'Pulldown', 'Pullover', 'Lateral raise', 'Dumbbell row')
 *   name the most common form, so M2's free text links to one entry.
 */
import { parseTable } from '../format.ts';
import type { SubstitutionGroups } from '../format.ts';

/** This part's substitution groups: key → the training intent every member preserves. */
export const groups: SubstitutionGroups = {
	horizontal_press:
		'Pressing away from the chest, lying, seated or in a push-up, for the chest, front delts and triceps.',
	bar_dip: 'Lowering the body between bars and pressing it back up, for the chest and triceps.',
	vertical_press_overhead:
		'Pressing a load, or the body, overhead to lockout for the shoulders and triceps.',
	vertical_press_shoulder_friendly:
		'Pressing up and forward instead of straight overhead, for a shoulder that cannot go overhead.',
	horizontal_row:
		'Rowing a load, or the body, toward the torso for the lats, upper back and rear delts.',
	rear_delt_pull:
		'Pulling the arms back and apart for the rear delts and upper back, to balance pressing.',
	vertical_pull:
		'Pulling the body up to a bar, or a handle down from overhead, for the lats and upper back.',
	straight_arm_pull:
		'Sweeping straight arms down from overhead to work the lats without the biceps.',
	chest_fly: 'Hugging the arms together in front of the chest to isolate the pecs.',
	lateral_raise: 'Raising the arms out to the side to isolate the side delts.',
	shoulder_external_rotation:
		'Turning the upper arm outward against light resistance, to keep the rotator cuff strong.',
	shrug: 'Shrugging the shoulders up against resistance for the traps.',
	elbow_flexion: 'Bending the elbow against resistance to isolate the biceps and forearms.',
	elbow_extension: 'Straightening the elbow against resistance to isolate the triceps.',
	neck_strength:
		'Moving the head against resistance to strengthen the neck for the clinch and taking strikes.',
	loaded_carry:
		'Walking with heavy weight in both hands or at the shoulders, for grip, traps and bracing.',
	offset_carry: 'Walking with weight on one side only, so the trunk resists leaning and twisting.',
	anti_extension_hold:
		'Holding the trunk rigid so the lower back cannot sag: the brace every heavy lift needs.',
	anti_extension_dynamic:
		'Moving the arms or legs away from the trunk while the lower back stays flat.',
	anti_rotation:
		'Pressing or reaching while the trunk resists twisting, for a steady core in strikes.',
	lateral_hold: 'Holding the trunk square while something pulls it sideways or twists it.',
	trunk_rotation:
		'Rotating the trunk against resistance: the turn behind a punch, a kick or a throw.',
	ab_crunch: 'Curling the ribs toward the pelvis to train the abs.',
	leg_raise: 'Curling the pelvis and legs up toward the ribs for the lower abs and hip flexors.',
	thoracic_mobility:
		'Rotation and extension range for the upper back, for overhead work and rotating strikes.',
	shoulder_mobility:
		'Overhead and rotation range for the shoulders, for pressing, pulling and holding a guard.',
	shoulder_stretch:
		'Lengthening the chest and the back of the shoulder, tight from pressing and holding a guard.'
};

export const exercises = parseTable(
	'src/lib/domain/exercises/catalogue/upper.ts',
	`
key | name | aliases | pattern | primary | secondary | equipment | group | skill | reps | seconds | uni | measure/load | tags | disciplines | lift

bench_press | Bench press | Barbell bench press, Flat bench press, Bench | horizontal_push | chest | front_delts, triceps | barbell, bench, squat_rack | horizontal_press | beginner | 3-8 | - | - | reps/external | compound, competition | powerlifting, strength, hypertrophy, athletic | bench_press
close_grip_bench_press | Close-grip bench press | Close-grip bench, CGBP | horizontal_push | triceps, chest | front_delts | barbell, bench, squat_rack | horizontal_press | beginner | 5-10 | - | - | reps/external | compound | powerlifting, strength, hypertrophy | -
incline_bench_press | Incline bench press | Incline barbell press, Incline press | horizontal_push | chest, front_delts | triceps | barbell, bench, squat_rack | horizontal_press | beginner | 5-10 | - | - | reps/external | compound | strength, hypertrophy, athletic | -
floor_press | Floor press | Barbell floor press | horizontal_push | triceps, chest | front_delts | barbell, squat_rack | horizontal_press | beginner | 3-8 | - | - | reps/external | compound, shoulder_friendly | powerlifting, strength | -
dumbbell_bench_press | Dumbbell bench press | DB bench press, Dumbbell chest press, Flat dumbbell press | horizontal_push | chest | front_delts, triceps | dumbbells, bench | horizontal_press | beginner | 6-12 | - | - | reps/external | compound | strength, hypertrophy, athletic, muay_thai | -
incline_dumbbell_press | Incline dumbbell press | Incline DB press, Incline dumbbell bench press | horizontal_push | chest, front_delts | triceps | dumbbells, bench | horizontal_press | beginner | 8-12 | - | - | reps/external | compound | hypertrophy, strength, athletic | -
dumbbell_floor_press | Dumbbell floor press | DB floor press | horizontal_push | chest, triceps | front_delts | dumbbells | horizontal_press | beginner | 8-12 | - | - | reps/external | compound, shoulder_friendly | strength, athletic, muay_thai | -
machine_chest_press | Machine chest press | Chest press, Seated chest press, Chest press machine | horizontal_push | chest | front_delts, triceps | machines | horizontal_press | beginner | 8-15 | - | - | reps/external | compound, back_friendly | hypertrophy, strength | -
push_up | Push-up | Press-up | horizontal_push | chest | triceps, front_delts, abs | - | horizontal_press | beginner | 8-20 | - | - | reps/bodyweight | compound, wrist_loading | athletic, muay_thai, strength, running | -
incline_push_up | Incline push-up | Hands-elevated push-up | horizontal_push | chest | triceps, front_delts | - | horizontal_press | beginner | 8-20 | - | - | reps/bodyweight | compound, wrist_loading | athletic, muay_thai, running | -

dip | Dip | Parallel bar dip, Bar dip | horizontal_push | chest, triceps | front_delts | pull_up_bar | bar_dip | beginner | 5-12 | - | - | reps/bodyweight | compound | strength, hypertrophy, athletic, muay_thai | -
assisted_dip | Assisted dip | Machine-assisted dip, Assisted dip machine | horizontal_push | chest, triceps | front_delts | machines | bar_dip | beginner | 6-12 | - | - | reps/assisted | compound | hypertrophy, strength | -

overhead_press | Overhead press | Strict press, Military press, OHP, Barbell overhead press | vertical_push | front_delts | side_delts, triceps, traps, abs | barbell, squat_rack | vertical_press_overhead | beginner | 3-8 | - | - | reps/external | compound, overhead, spinal_loading | strength, weightlifting, powerlifting, athletic | overhead_press
push_press | Push press | - | vertical_push | front_delts | triceps, side_delts, quads, glutes | barbell, squat_rack | vertical_press_overhead | intermediate | 3-6 | - | - | reps/external | compound, explosive, overhead, spinal_loading | weightlifting, strength, athletic | -
seated_dumbbell_shoulder_press | Seated dumbbell shoulder press | Seated dumbbell press, Dumbbell shoulder press | vertical_push | front_delts | side_delts, triceps | dumbbells, bench | vertical_press_overhead | beginner | 8-12 | - | - | reps/external | compound, overhead, back_friendly | hypertrophy, strength | -
standing_dumbbell_shoulder_press | Standing dumbbell shoulder press | Standing dumbbell press | vertical_push | front_delts | side_delts, triceps, abs | dumbbells | vertical_press_overhead | beginner | 6-12 | - | - | reps/external | compound, overhead | strength, athletic, muay_thai | -
single_arm_dumbbell_overhead_press | Single-arm dumbbell overhead press | Single-arm dumbbell press, One-arm dumbbell press | vertical_push | front_delts | side_delts, triceps, obliques | dumbbells | vertical_press_overhead | beginner | 6-10 | - | y | reps/external | compound, overhead | athletic, strength, muay_thai | -
kettlebell_press | Kettlebell press | Single-arm kettlebell press, KB press, Kettlebell overhead press | vertical_push | front_delts | side_delts, triceps, obliques | kettlebells | vertical_press_overhead | beginner | 5-10 | - | y | reps/external | compound, overhead | strength, athletic, muay_thai | -
bottoms_up_kettlebell_press | Bottoms-up kettlebell press | Bottoms-up press | vertical_push | front_delts | side_delts, triceps, forearms | kettlebells | vertical_press_overhead | intermediate | 5-8 | - | y | reps/external | compound, overhead, shoulder_friendly, grip_demanding | athletic, muay_thai, strength | -
handstand_push_up | Handstand push-up | HSPU, Wall handstand push-up | vertical_push | front_delts | triceps, side_delts, traps, abs | - | vertical_press_overhead | advanced | 3-8 | - | - | reps/bodyweight | compound, overhead, wrist_loading | athletic | -
pike_push_up | Pike push-up | - | vertical_push | front_delts | triceps, side_delts, chest | - | vertical_press_overhead | beginner | 6-12 | - | - | reps/bodyweight | compound, overhead, wrist_loading | athletic, muay_thai | -

landmine_press | Landmine press | Single-arm landmine press, Standing landmine press | vertical_push | front_delts, chest | triceps, obliques | barbell | vertical_press_shoulder_friendly | beginner | 6-10 | - | y | reps/external | compound, shoulder_friendly | strength, athletic, muay_thai | -
half_kneeling_landmine_press | Half-kneeling landmine press | - | vertical_push | front_delts, chest | triceps, obliques, glutes | barbell | vertical_press_shoulder_friendly | beginner | 6-10 | - | y | reps/external | compound, shoulder_friendly | athletic, muay_thai, strength | -

barbell_row | Barbell row | Bent-over row, Barbell bent-over row | horizontal_pull | upper_back, lats | rear_delts, biceps, lower_back, forearms | barbell | horizontal_row | beginner | 6-10 | - | - | reps/external | compound, spinal_loading, grip_demanding | strength, hypertrophy, powerlifting, athletic | -
chest_supported_dumbbell_row | Chest-supported dumbbell row | Incline dumbbell row, Chest-supported row | horizontal_pull | upper_back, lats | rear_delts, biceps | dumbbells, bench | horizontal_row | beginner | 8-12 | - | - | reps/external | compound, back_friendly | hypertrophy, strength, athletic | -
single_arm_dumbbell_row | Single-arm dumbbell row | One-arm dumbbell row, Dumbbell row | horizontal_pull | lats, upper_back | rear_delts, biceps, forearms | dumbbells, bench | horizontal_row | beginner | 8-12 | - | y | reps/external | compound, back_friendly | strength, hypertrophy, athletic, muay_thai | -
renegade_row | Renegade row | Plank row | horizontal_pull | lats, upper_back | abs, obliques, biceps, front_delts | dumbbells | horizontal_row | intermediate | 6-10 | - | y | reps/external | compound, wrist_loading | athletic, muay_thai | -
seated_cable_row | Seated cable row | Cable row, Low row, Seated row | horizontal_pull | upper_back, lats | rear_delts, biceps | cables | horizontal_row | beginner | 8-12 | - | - | reps/external | compound | hypertrophy, strength, athletic | -
inverted_row | Inverted row | Bodyweight row, Australian pull-up | horizontal_pull | upper_back, lats | rear_delts, biceps, abs | barbell, squat_rack | horizontal_row | beginner | 6-15 | - | - | reps/bodyweight | compound | athletic, muay_thai, strength, running | -
ring_row | Ring row | Suspension row | horizontal_pull | upper_back, lats | rear_delts, biceps, abs | rings | horizontal_row | beginner | 8-15 | - | - | reps/bodyweight | compound | athletic, muay_thai, running | -

face_pull | Face pull | Cable face pull, Rope face pull | horizontal_pull | rear_delts, upper_back | traps | cables | rear_delt_pull | beginner | 12-20 | - | - | reps/external | shoulder_friendly | strength, hypertrophy, powerlifting, muay_thai, athletic | -
band_pull_apart | Band pull-apart | Pull-apart | horizontal_pull | rear_delts, upper_back | - | bands | rear_delt_pull | beginner | 15-25 | - | - | reps/none | shoulder_friendly | strength, powerlifting, muay_thai, athletic, running | -
reverse_dumbbell_fly | Reverse dumbbell fly | Reverse fly, Rear delt fly, Bent-over reverse fly | horizontal_pull | rear_delts | upper_back | dumbbells | rear_delt_pull | beginner | 12-20 | - | - | reps/external | shoulder_friendly | hypertrophy, strength, athletic | -

pull_up | Pull-up | Overhand pull-up | vertical_pull | lats, upper_back | biceps, rear_delts, forearms | pull_up_bar | vertical_pull | beginner | 3-10 | - | - | reps/bodyweight | compound, grip_demanding | strength, hypertrophy, athletic, muay_thai | -
chin_up | Chin-up | Underhand pull-up, Supinated pull-up | vertical_pull | lats, biceps | upper_back, forearms | pull_up_bar | vertical_pull | beginner | 3-10 | - | - | reps/bodyweight | compound, grip_demanding | strength, hypertrophy, athletic | -
neutral_grip_pull_up | Neutral-grip pull-up | Hammer-grip pull-up, Parallel-grip pull-up | vertical_pull | lats, upper_back | biceps, forearms | pull_up_bar | vertical_pull | beginner | 3-10 | - | - | reps/bodyweight | compound, grip_demanding, shoulder_friendly | strength, hypertrophy, athletic, muay_thai | -
weighted_pull_up | Weighted pull-up | - | vertical_pull | lats, upper_back | biceps, rear_delts, forearms | pull_up_bar, dumbbells | vertical_pull | intermediate | 3-6 | - | - | reps/external | compound, grip_demanding | strength, athletic, hypertrophy | weighted_pull_up
lat_pulldown | Lat pulldown | Pulldown, Wide-grip pulldown, Cable pulldown | vertical_pull | lats, upper_back | biceps, rear_delts | cables | vertical_pull | beginner | 8-12 | - | - | reps/external | compound | hypertrophy, strength, athletic | -
assisted_pull_up | Assisted pull-up | Machine-assisted pull-up, Assisted pull-up machine | vertical_pull | lats, upper_back | biceps | machines | vertical_pull | beginner | 6-12 | - | - | reps/assisted | compound | hypertrophy, strength | -
band_assisted_pull_up | Band-assisted pull-up | Banded pull-up | vertical_pull | lats, upper_back | biceps, forearms | pull_up_bar, bands | vertical_pull | beginner | 5-10 | - | - | reps/assisted | compound, grip_demanding | strength, athletic, muay_thai | -
band_pulldown | Band pulldown | Band lat pulldown | vertical_pull | lats | upper_back, biceps | bands | vertical_pull | beginner | 12-20 | - | - | reps/none | compound | athletic, running, muay_thai | -

straight_arm_pulldown | Straight-arm pulldown | Straight-arm lat pulldown, Cable pullover | vertical_pull | lats | triceps, rear_delts | cables | straight_arm_pull | beginner | 10-15 | - | - | reps/external | - | hypertrophy, strength, muay_thai | -
dumbbell_pullover | Dumbbell pullover | Pullover, DB pullover | vertical_pull | lats, chest | triceps | dumbbells, bench | straight_arm_pull | beginner | 8-12 | - | - | reps/external | overhead | hypertrophy, strength | -
floor_pullover | Floor pullover | Dumbbell floor pullover | vertical_pull | lats, chest | triceps | dumbbells | straight_arm_pull | beginner | 10-15 | - | - | reps/external | overhead | strength, athletic, muay_thai | -

dumbbell_fly | Dumbbell fly | Dumbbell flye, DB fly, Flat dumbbell fly | isolation | chest | front_delts | dumbbells, bench | chest_fly | beginner | 10-15 | - | - | reps/external | - | hypertrophy | -
cable_fly | Cable fly | Cable crossover, Cable chest fly | isolation | chest | front_delts | cables | chest_fly | beginner | 10-15 | - | - | reps/external | - | hypertrophy | -
dumbbell_lateral_raise | Dumbbell lateral raise | Lateral raise, Side raise, DB lateral raise | isolation | side_delts | traps | dumbbells | lateral_raise | beginner | 10-20 | - | - | reps/external | - | hypertrophy, strength, athletic, muay_thai | -
cable_lateral_raise | Cable lateral raise | Single-arm cable lateral raise | isolation | side_delts | traps | cables | lateral_raise | beginner | 12-20 | - | y | reps/external | - | hypertrophy | -
band_external_rotation | Band external rotation | External rotation, Banded external rotation | isolation | rear_delts | upper_back | bands | shoulder_external_rotation | beginner | 12-20 | - | y | reps/none | shoulder_friendly | muay_thai, strength, powerlifting, athletic | -
cable_external_rotation | Cable external rotation | - | isolation | rear_delts | upper_back | cables | shoulder_external_rotation | beginner | 12-20 | - | y | reps/external | shoulder_friendly | strength, powerlifting, athletic, muay_thai | -
barbell_shrug | Barbell shrug | Shrug | isolation | traps | forearms | barbell | shrug | beginner | 8-15 | - | - | reps/external | grip_demanding | strength, hypertrophy, muay_thai | -
dumbbell_shrug | Dumbbell shrug | DB shrug | isolation | traps | forearms | dumbbells | shrug | beginner | 10-15 | - | - | reps/external | grip_demanding | hypertrophy, muay_thai, strength | -
barbell_curl | Barbell curl | EZ-bar curl, Standing barbell curl | isolation | biceps | forearms | barbell | elbow_flexion | beginner | 8-12 | - | - | reps/external | - | hypertrophy, strength | -
dumbbell_curl | Dumbbell curl | Biceps curl, DB curl | isolation | biceps | forearms | dumbbells | elbow_flexion | beginner | 8-15 | - | - | reps/external | - | hypertrophy, strength, athletic | -
hammer_curl | Hammer curl | Dumbbell hammer curl | isolation | biceps, forearms | - | dumbbells | elbow_flexion | beginner | 8-15 | - | - | reps/external | - | hypertrophy, strength, muay_thai | -
triceps_pushdown | Triceps pushdown | Cable pushdown, Rope pushdown, Pushdown | isolation | triceps | - | cables | elbow_extension | beginner | 10-15 | - | - | reps/external | - | hypertrophy, strength, powerlifting | -
skull_crusher | Skull crusher | Lying triceps extension, EZ-bar skull crusher | isolation | triceps | - | barbell, bench | elbow_extension | beginner | 8-12 | - | - | reps/external | - | hypertrophy, strength, powerlifting | -
overhead_dumbbell_triceps_extension | Overhead dumbbell triceps extension | Overhead triceps extension, Dumbbell overhead extension | isolation | triceps | - | dumbbells | elbow_extension | beginner | 10-15 | - | - | reps/external | overhead | hypertrophy, strength, athletic | -
lying_neck_curl | Lying neck curl | Neck curl, Neck flexion | isolation | neck | - | bench | neck_strength | beginner | 12-20 | - | - | reps/bodyweight | - | muay_thai, athletic | -
lying_neck_extension | Lying neck extension | Neck extension, Prone neck extension | isolation | neck | traps | bench | neck_strength | beginner | 12-20 | - | - | reps/bodyweight | - | muay_thai, athletic | -
lying_lateral_neck_raise | Lying lateral neck raise | Side-lying neck raise, Lateral neck flexion | isolation | neck | traps | bench | neck_strength | beginner | 12-20 | - | y | reps/bodyweight | - | muay_thai, athletic | -

farmers_carry | Farmer's carry | Farmer's walk, Dumbbell farmer's carry | carry | forearms, traps | upper_back, abs, obliques | dumbbells | loaded_carry | beginner | - | - | - | distance/external | grip_demanding | strength, athletic, muay_thai, powerlifting | -
kettlebell_rack_carry | Kettlebell rack carry | Front rack carry, Double kettlebell rack carry | carry | abs, upper_back | obliques, biceps, front_delts | kettlebells | loaded_carry | beginner | - | - | - | distance/external | - | athletic, muay_thai, strength | -
suitcase_carry | Suitcase carry | Single-arm farmer's carry, One-arm farmer's carry | carry | obliques, forearms | traps, abs, glutes | dumbbells | offset_carry | beginner | - | - | y | distance/external | grip_demanding | athletic, muay_thai, running, distance_running, strength | -
waiters_walk | Waiter's walk | Overhead carry, Single-arm overhead carry | carry | front_delts, obliques | side_delts, traps, abs | kettlebells | offset_carry | intermediate | - | - | y | distance/external | overhead | athletic, muay_thai, strength | -

plank | Plank | Front plank, Forearm plank | anti_extension | abs | obliques, front_delts | - | anti_extension_hold | beginner | - | 45 | - | time/bodyweight | back_friendly | athletic, muay_thai, running, distance_running, strength | -
hollow_body_hold | Hollow body hold | Hollow hold | anti_extension | abs | hip_flexors | - | anti_extension_hold | intermediate | - | 30 | - | time/bodyweight | - | athletic, muay_thai | -
dead_bug | Dead bug | - | anti_extension | abs | hip_flexors | - | anti_extension_dynamic | beginner | 6-10 | - | y | reps/bodyweight | back_friendly | running, distance_running, athletic, muay_thai, strength | -
rollout | Rollout | Ab wheel rollout, Barbell rollout, Ab rollout | anti_extension | abs | lats, front_delts, hip_flexors | barbell | anti_extension_dynamic | intermediate | 6-12 | - | - | reps/bodyweight | - | strength, athletic, muay_thai | -

pallof_press | Pallof press | Cable Pallof press, Anti-rotation press | anti_rotation | obliques, abs | - | cables | anti_rotation | beginner | 8-12 | - | y | reps/external | back_friendly | athletic, muay_thai, running, distance_running, strength | -
band_pallof_press | Band Pallof press | Banded Pallof press | anti_rotation | obliques, abs | - | bands | anti_rotation | beginner | 8-12 | - | y | reps/none | back_friendly | athletic, muay_thai, running, distance_running | -
bird_dog | Bird dog | - | anti_rotation | lower_back, glutes | abs, obliques | - | anti_rotation | beginner | 6-10 | - | y | reps/bodyweight | back_friendly | running, distance_running, athletic, muay_thai, powerlifting | -
side_plank | Side plank | Side bridge | anti_rotation | obliques | abs, glutes | - | lateral_hold | beginner | - | 30 | y | time/bodyweight | back_friendly | running, distance_running, athletic, muay_thai, strength | -
pallof_hold | Pallof hold | Pallof iso hold | anti_rotation | obliques, abs | - | cables | lateral_hold | beginner | - | 30 | y | time/external | back_friendly | athletic, muay_thai, running | -

cable_woodchop | Cable woodchop | Woodchop, Cable chop | rotation | obliques | abs, glutes | cables | trunk_rotation | beginner | 8-12 | - | y | reps/external | - | muay_thai, athletic | -
landmine_rotation | Landmine rotation | Landmine twist, Landmine 180 | rotation | obliques | abs, front_delts, glutes | barbell | trunk_rotation | intermediate | 6-10 | - | y | reps/external | - | muay_thai, athletic | -
russian_twist | Russian twist | - | rotation | obliques | abs, hip_flexors | - | trunk_rotation | beginner | 10-20 | - | y | reps/bodyweight | - | muay_thai, athletic | -

crunch | Crunch | Ab crunch | trunk_flexion | abs | - | - | ab_crunch | beginner | 12-20 | - | - | reps/bodyweight | - | athletic, muay_thai, hypertrophy | -
cable_crunch | Cable crunch | Kneeling cable crunch | trunk_flexion | abs | obliques | cables | ab_crunch | beginner | 10-15 | - | - | reps/external | - | hypertrophy, strength, athletic | -
sit_up | Sit-up | - | trunk_flexion | abs, hip_flexors | - | - | ab_crunch | beginner | 10-20 | - | - | reps/bodyweight | - | muay_thai, athletic | -
hanging_leg_raise | Hanging leg raise | Hanging straight-leg raise | trunk_flexion | abs, hip_flexors | obliques, forearms | pull_up_bar | leg_raise | intermediate | 6-12 | - | - | reps/bodyweight | grip_demanding | athletic, muay_thai, strength, hypertrophy | -
hanging_knee_raise | Hanging knee raise | Knee raise | trunk_flexion | abs, hip_flexors | forearms | pull_up_bar | leg_raise | beginner | 8-15 | - | - | reps/bodyweight | grip_demanding | athletic, muay_thai, hypertrophy | -
reverse_crunch | Reverse crunch | - | trunk_flexion | abs | hip_flexors | - | leg_raise | beginner | 10-15 | - | - | reps/bodyweight | - | athletic, muay_thai, hypertrophy | -

thread_the_needle | Thread the needle | - | mobility | upper_back | rear_delts | - | thoracic_mobility | beginner | - | 45 | y | time/none | - | muay_thai, athletic, strength, running | -
open_book | Open book | Side-lying open book, Open book stretch | mobility | upper_back | chest | - | thoracic_mobility | beginner | - | 45 | y | time/none | - | muay_thai, athletic, running, weightlifting | -
wall_slide | Wall slide | Wall angel | mobility | upper_back | front_delts | - | shoulder_mobility | beginner | - | 45 | - | time/none | - | weightlifting, strength, athletic, muay_thai | -
band_pass_through | Band pass-through | Shoulder pass-through, Band shoulder dislocate, Shoulder dislocate | mobility | front_delts, chest | upper_back | bands | shoulder_mobility | beginner | - | 45 | - | time/none | - | weightlifting, strength, athletic, muay_thai | -
kettlebell_halo | Kettlebell halo | Halo | mobility | side_delts, upper_back | triceps, abs | kettlebells | shoulder_mobility | beginner | - | 45 | - | time/external | - | muay_thai, athletic, weightlifting | -
dead_hang | Dead hang | Passive hang, Bar hang | mobility | lats, forearms | upper_back | pull_up_bar | shoulder_mobility | beginner | - | 30 | - | time/bodyweight | grip_demanding | strength, athletic, muay_thai, weightlifting | -
doorway_pec_stretch | Doorway pec stretch | Doorway chest stretch, Pec stretch, Chest stretch | mobility | chest | front_delts | - | shoulder_stretch | beginner | - | 45 | y | time/none | - | strength, hypertrophy, powerlifting, muay_thai | -
cross_body_shoulder_stretch | Cross-body shoulder stretch | Cross-body stretch, Posterior shoulder stretch | mobility | rear_delts | upper_back | - | shoulder_stretch | beginner | - | 30 | y | time/none | - | muay_thai, strength, athletic, running | -
`
);
