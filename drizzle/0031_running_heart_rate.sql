ALTER TABLE "running_profiles" ADD COLUMN "max_hr" smallint;--> statement-breakpoint
ALTER TABLE "running_profiles" ADD COLUMN "resting_hr" smallint;--> statement-breakpoint
ALTER TABLE "running_profiles" ADD COLUMN "threshold_hr" smallint;--> statement-breakpoint
ALTER TABLE "running_profiles" ADD CONSTRAINT "running_profiles_max_hr_ck" CHECK (max_hr between 120 and 230);--> statement-breakpoint
ALTER TABLE "running_profiles" ADD CONSTRAINT "running_profiles_resting_hr_ck" CHECK (resting_hr between 30 and 110);--> statement-breakpoint
ALTER TABLE "running_profiles" ADD CONSTRAINT "running_profiles_threshold_hr_ck" CHECK (threshold_hr between 100 and 225);--> statement-breakpoint
ALTER TABLE "running_profiles" ADD CONSTRAINT "running_profiles_hr_order_ck" CHECK ((resting_hr is null or threshold_hr is null or resting_hr < threshold_hr) and (threshold_hr is null or max_hr is null or threshold_hr < max_hr) and (resting_hr is null or max_hr is null or resting_hr < max_hr));