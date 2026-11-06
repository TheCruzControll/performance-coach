/**
 * Training-profile use-cases (PRD §2, §3). Routes call these; the coach (M5) calls the same
 * functions as tools, so validation and history are identical for both.
 */
export {
	isProfileInputError,
	ProfileInputError,
	ProfileNotFoundError,
	type ChangeSource,
	type ProfileDeps
} from './shared';
export {
	createGoal,
	deleteGoal,
	goalHistory,
	listGoals,
	reorderGoals,
	setGoalStatus,
	updateGoal
} from './goals';
export {
	baselineHistory,
	getBaselines,
	getEquipment,
	getExercisePreferences,
	getExperience,
	getInjuries,
	getSchedule,
	getSpecifics,
	saveBaselines,
	saveEquipment,
	saveExercisePreferences,
	saveExperience,
	saveInjuries,
	saveSchedule,
	saveSpecifics,
	type Specifics
} from './sections';
export {
	advanceOnboarding,
	completeOnboarding,
	getAthleteProfile,
	getBody,
	getOnboarding,
	getProfileOverview,
	getTrainingProfile,
	rememberOnboardingStep,
	saveBasics,
	saveBody,
	type OnboardingState,
	type ProfileOverview
} from './profile';
