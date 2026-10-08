-- Additive, guarded installation. Existing identities/credentials/flags are untouched.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "internalEmail" boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS account_username_unique ON "user" (lower(username)) WHERE username IS NOT NULL;
CREATE TABLE IF NOT EXISTS account_access (
 account_id text PRIMARY KEY REFERENCES "user"(id),
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
 recovery_verifier text CHECK(recovery_verifier ~ '^[a-f0-9]{64}$'),
 current_email text CHECK(current_email ~ '^[^@]+@example[.]test$'),
 pending_email text CHECK(pending_email ~ '^[^@]+@example[.]test$'),
 contact_generation bigint NOT NULL DEFAULT 1 CHECK(contact_generation>0)
);
CREATE TABLE IF NOT EXISTS account_token (
 account_id text NOT NULL REFERENCES account_access(account_id),
 purpose text NOT NULL CHECK(purpose IN ('verify','reset')),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 generation bigint NOT NULL, contact_generation bigint NOT NULL,
 recipient text NOT NULL CHECK(recipient ~ '^[^@]+@example[.]test$'),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,purpose)
);
-- Fixed 256 counters; no raw network identity or caller text stored.
CREATE TABLE IF NOT EXISTS account_admission (
 bucket smallint PRIMARY KEY CHECK(bucket BETWEEN 0 AND 255),
 starts_at timestamptz NOT NULL, attempts integer NOT NULL CHECK(attempts>0)
);
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS access_owner text REFERENCES "user"(id);
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS access_purpose text;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS access_digest text;
GRANT SELECT,INSERT,UPDATE,DELETE ON account_access,account_token,account_admission TO lab_runtime;
