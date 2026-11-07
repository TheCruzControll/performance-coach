CREATE TABLE "email_sign_in_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"session_id" uuid,
	CONSTRAINT "email_sign_in_links_token_hash_ck" CHECK ("email_sign_in_links"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "email_sign_in_links_lifetime_ck" CHECK ("email_sign_in_links"."expires_at" > "email_sign_in_links"."created_at" and "email_sign_in_links"."expires_at" <= "email_sign_in_links"."created_at" + interval '15 minutes'),
	CONSTRAINT "email_sign_in_links_state_ck" CHECK ("email_sign_in_links"."used_at" is null or "email_sign_in_links"."revoked_at" is null),
	CONSTRAINT "email_sign_in_links_session_ck" CHECK ("email_sign_in_links"."session_id" is null or "email_sign_in_links"."used_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "auth_events" DROP CONSTRAINT "auth_events_type_ck";--> statement-breakpoint
ALTER TABLE "auth_sessions" DROP CONSTRAINT "auth_sessions_method_ck";--> statement-breakpoint
ALTER TABLE "email_sign_in_links" ADD CONSTRAINT "email_sign_in_links_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sign_in_links" ADD CONSTRAINT "email_sign_in_links_session_id_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_sign_in_links_token_hash_uq" ON "email_sign_in_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "email_sign_in_links_owner_live_idx" ON "email_sign_in_links" USING btree ("owner_id") WHERE "email_sign_in_links"."used_at" is null and "email_sign_in_links"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "email_sign_in_links_expires_idx" ON "email_sign_in_links" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_type_ck" CHECK (type in ('setup.completed', 'setup.failed', 'signin.succeeded', 'signin.failed', 'passkey.added', 'passkey.renamed', 'passkey.removed', 'recovery.used', 'recovery.failed', 'recovery.regenerated', 'session.revoked', 'session.revoked_others', 'reauth.succeeded', 'reauth.failed', 'signout', 'rate_limited', 'owner.reset', 'email_link.requested', 'email_link.sent', 'email_link.send_failed', 'email_link.used', 'email_link.expired', 'email_link.refused'));--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_method_ck" CHECK (method in ('setup', 'passkey', 'recovery', 'test', 'email_link'));