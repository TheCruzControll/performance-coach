CREATE TABLE "auth_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "auth_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"owner_id" uuid,
	"session_id" uuid,
	"credential_id" text,
	"request_id" text,
	"ip" text,
	"user_agent" text,
	"detail" jsonb,
	CONSTRAINT "auth_events_type_ck" CHECK (type in ('setup.completed', 'setup.failed', 'signin.succeeded', 'signin.failed', 'passkey.added', 'passkey.renamed', 'passkey.removed', 'recovery.used', 'recovery.failed', 'recovery.regenerated', 'session.revoked', 'session.revoked_others', 'signout', 'rate_limited'))
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"kind" text DEFAULT 'owner' NOT NULL,
	"method" text NOT NULL,
	"credential_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "auth_sessions_kind_ck" CHECK (kind in ('owner', 'recovery')),
	CONSTRAINT "auth_sessions_method_ck" CHECK (method in ('setup', 'passkey', 'recovery', 'test')),
	CONSTRAINT "auth_sessions_token_hash_ck" CHECK ("auth_sessions"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_sessions_expiry_ck" CHECK ("auth_sessions"."expires_at" <= "auth_sessions"."absolute_expires_at")
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"display_name" text NOT NULL,
	"webauthn_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"setup_completed_at" timestamp with time zone,
	CONSTRAINT "owners_singleton_ck" CHECK ("owners"."singleton"),
	CONSTRAINT "owners_display_name_ck" CHECK (char_length("owners"."display_name") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "passkey_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}'::text[] NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"aaguid" text,
	"nickname" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "passkey_credentials_device_type_ck" CHECK (device_type in ('singleDevice', 'multiDevice')),
	CONSTRAINT "passkey_credentials_nickname_ck" CHECK (char_length("passkey_credentials"."nickname") between 1 and 64),
	CONSTRAINT "passkey_credentials_counter_ck" CHECK ("passkey_credentials"."counter" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recovery_codes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"owner_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "recovery_codes_code_hash_ck" CHECK ("recovery_codes"."code_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge" text NOT NULL,
	"purpose" text NOT NULL,
	"rp_id" text NOT NULL,
	"session_id" uuid,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "webauthn_challenges_purpose_ck" CHECK (purpose in ('setup', 'authenticate', 'register'))
);
--> statement-breakpoint
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_credential_id_passkey_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."passkey_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_credentials" ADD CONSTRAINT "passkey_credentials_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_session_id_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_events_occurred_at_idx" ON "auth_events" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auth_events_type_idx" ON "auth_events" USING btree ("type","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auth_rate_limits_window_idx" ON "auth_rate_limits" USING btree ("window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_hash_uq" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_owner_active_idx" ON "auth_sessions" USING btree ("owner_id","last_seen_at" DESC NULLS LAST) WHERE "auth_sessions"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "owners_singleton_uq" ON "owners" USING btree ("singleton");--> statement-breakpoint
CREATE UNIQUE INDEX "owners_webauthn_user_id_uq" ON "owners" USING btree ("webauthn_user_id");--> statement-breakpoint
CREATE INDEX "passkey_credentials_owner_idx" ON "passkey_credentials" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_codes_code_hash_uq" ON "recovery_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "recovery_codes_owner_idx" ON "recovery_codes" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webauthn_challenges_challenge_uq" ON "webauthn_challenges" USING btree ("challenge");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_expires_idx" ON "webauthn_challenges" USING btree ("expires_at");