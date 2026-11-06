CREATE TABLE "used_setup_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "used_setup_tokens_token_hash_ck" CHECK ("used_setup_tokens"."token_hash" ~ '^[0-9a-f]{64}$')
);
