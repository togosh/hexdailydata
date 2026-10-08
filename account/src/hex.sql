-- Account-only additive candidate. Existing populated financial rows are retained.
ALTER TABLE invoice DROP CONSTRAINT IF EXISTS invoice_mode_check;
ALTER TABLE invoice ADD CONSTRAINT invoice_mode_check CHECK(mode IN ('pls','card','hex'));
ALTER TABLE invoice DROP CONSTRAINT IF EXISTS invoice_check;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='invoice' AND column_name='term_kind') THEN
  ALTER TABLE invoice ADD CONSTRAINT invoice_check CHECK (
   (term_kind='fixed30' AND calendar_months IS NULL AND ((mode IN ('pls','hex') AND days IS NOT NULL) OR (mode='card' AND period_start<period_end))) OR
   (term_kind='calendar-v1' AND mode='hex' AND days IS NULL AND calendar_months IS NOT NULL AND calendar_months IN(1,12)));
 ELSE
  ALTER TABLE invoice ADD CONSTRAINT invoice_check CHECK
   ((mode IN ('pls','hex') AND days IS NOT NULL) OR (mode='card' AND period_start<period_end));
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS hex_profile (
 id text PRIMARY KEY, config jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hex_price (
 id text PRIMARY KEY, snapshot jsonb NOT NULL, actor text NOT NULL, created_at timestamptz NOT NULL,
 published_seq bigserial UNIQUE
);
CREATE TABLE IF NOT EXISTS hex_stream (
 profile_id text PRIMARY KEY REFERENCES hex_profile(id), cursor_height bigint NOT NULL,
 cursor_hash text NOT NULL, head jsonb, finalized jsonb, refreshed_at timestamptz,
 paused boolean NOT NULL DEFAULT false, reason text, span integer NOT NULL DEFAULT 256 CHECK(span BETWEEN 1 AND 256),
 lease uuid, lease_until timestamptz, calls bigint NOT NULL DEFAULT 0, bytes bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hex_tick (
 id uuid PRIMARY KEY, profile_id text NOT NULL REFERENCES hex_profile(id), started_at timestamptz NOT NULL,
 deadline timestamptz NOT NULL, calls int NOT NULL DEFAULT 0 CHECK(calls BETWEEN 0 AND 80),
 bytes bigint NOT NULL DEFAULT 0 CHECK(bytes BETWEEN 0 AND 16777216), state text NOT NULL DEFAULT 'running', reason text
);
CREATE TABLE IF NOT EXISTS hex_quote (
 invoice_id uuid PRIMARY KEY REFERENCES invoice(id), account_id text NOT NULL REFERENCES customer(id),
 request_id uuid NOT NULL, profile_id text NOT NULL REFERENCES hex_profile(id), price_id text NOT NULL REFERENCES hex_price(id),
 snapshot jsonb NOT NULL, base_hearts numeric(78,0) NOT NULL, adjustment int NOT NULL CHECK(adjustment>0),
 amount_hearts numeric(78,0) NOT NULL CHECK(amount_hearts>0 AND amount_hearts<115792089237316195423570985008687907853269984665640564039457584007913129639936),
 issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, fence_height bigint NOT NULL, fence_hash text NOT NULL,
 reserved boolean NOT NULL DEFAULT true, status text NOT NULL DEFAULT 'open', reason text,
 grant_id uuid UNIQUE, payment_key text UNIQUE, actual_hearts numeric(78,0),
 UNIQUE(account_id,request_id), CHECK(expires_at>issued_at), CHECK(amount_hearts=base_hearts+adjustment)
);
CREATE UNIQUE INDEX IF NOT EXISTS hex_one_reserved ON hex_quote(account_id) WHERE reserved;
CREATE TABLE IF NOT EXISTS hex_assignment (
 chain int NOT NULL, token text NOT NULL, recipient text NOT NULL, amount_hearts numeric(78,0) NOT NULL,
 invoice_id uuid NOT NULL UNIQUE REFERENCES hex_quote(invoice_id),
 PRIMARY KEY(chain,token,recipient,amount_hearts),
 CHECK(chain=369 AND token ~ '^0x[0-9a-f]{40}$' AND recipient ~ '^0x[0-9a-f]{40}$')
);
CREATE TABLE IF NOT EXISTS hex_issue_rate (
 account_id text PRIMARY KEY REFERENCES customer(id), window_at timestamptz NOT NULL, attempts int NOT NULL
);
CREATE TABLE IF NOT EXISTS hex_observation (
 payment_key text PRIMARY KEY, profile_id text NOT NULL REFERENCES hex_profile(id),
 tx_hash text NOT NULL, log_index int NOT NULL, amount_hearts numeric(78,0),
 proof jsonb NOT NULL, proof_digest text NOT NULL, valid boolean NOT NULL, reason text,
 assigned_invoice uuid REFERENCES hex_quote(invoice_id), consumed_invoice uuid UNIQUE REFERENCES hex_quote(invoice_id),
 observed_at timestamptz NOT NULL, UNIQUE(profile_id,tx_hash,log_index)
);
CREATE TABLE IF NOT EXISTS hex_case (
 id uuid PRIMARY KEY, invoice_id uuid NOT NULL UNIQUE REFERENCES hex_quote(invoice_id), account_id text NOT NULL REFERENCES customer(id),
 reason text NOT NULL, hint_hash text, hint_index int, payment_key text REFERENCES hex_observation(payment_key),
 hint_revisions int NOT NULL DEFAULT 0 CHECK(hint_revisions BETWEEN 0 AND 3),
 status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL, attempts int NOT NULL DEFAULT 0,
 message text, message_digest text, challenge_expires timestamptz, challenge_proof_digest text,
 proof_digest text, signature_digest text, proven_at timestamptz, resolution jsonb
);
CREATE TABLE IF NOT EXISTS hex_action (
 id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES hex_case(id), actor text NOT NULL,
 action text NOT NULL, reason text NOT NULL, note text NOT NULL, digest text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL
);
CREATE OR REPLACE FUNCTION hex_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'HEX_IMMUTABLE_HISTORY'; END $$;
CREATE OR REPLACE TRIGGER hex_assignment_immutable BEFORE UPDATE OR DELETE ON hex_assignment FOR EACH ROW EXECUTE FUNCTION hex_immutable();
CREATE OR REPLACE TRIGGER hex_profile_immutable BEFORE UPDATE OR DELETE ON hex_profile FOR EACH ROW EXECUTE FUNCTION hex_immutable();
CREATE OR REPLACE TRIGGER hex_price_immutable BEFORE UPDATE OR DELETE ON hex_price FOR EACH ROW EXECUTE FUNCTION hex_immutable();
CREATE OR REPLACE FUNCTION hex_quote_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'HEX_IMMUTABLE_QUOTE'; END IF;
 IF ROW(NEW.invoice_id,NEW.account_id,NEW.request_id,NEW.profile_id,NEW.price_id,NEW.snapshot,NEW.base_hearts,NEW.adjustment,NEW.amount_hearts,NEW.issued_at,NEW.expires_at,NEW.fence_height,NEW.fence_hash)
 IS DISTINCT FROM ROW(OLD.invoice_id,OLD.account_id,OLD.request_id,OLD.profile_id,OLD.price_id,OLD.snapshot,OLD.base_hearts,OLD.adjustment,OLD.amount_hearts,OLD.issued_at,OLD.expires_at,OLD.fence_height,OLD.fence_hash)
 THEN RAISE EXCEPTION 'HEX_IMMUTABLE_QUOTE'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER hex_quote_immutable BEFORE UPDATE OR DELETE ON hex_quote FOR EACH ROW EXECUTE FUNCTION hex_quote_terms();
GRANT SELECT,INSERT,UPDATE ON hex_stream,hex_tick,hex_quote,hex_issue_rate,hex_observation,hex_case,hex_action TO lab_runtime;
GRANT SELECT,INSERT ON hex_profile,hex_price,hex_assignment TO lab_runtime;
GRANT USAGE,SELECT ON SEQUENCE hex_price_published_seq_seq TO lab_runtime;

-- Recovery correction: additive on existing r2 tables; no separate queue or history deletion.
ALTER TABLE hex_case ADD COLUMN IF NOT EXISTS retry_due timestamptz;
ALTER TABLE hex_case ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
ALTER TABLE hex_case ADD COLUMN IF NOT EXISTS retry_state text NOT NULL DEFAULT 'ready' CHECK(retry_state IN ('ready','parked','done'));
ALTER TABLE hex_case ADD COLUMN IF NOT EXISTS retry_reason text;
ALTER TABLE hex_case ADD COLUMN IF NOT EXISTS prior_resolution jsonb;
ALTER TABLE hex_observation ADD COLUMN IF NOT EXISTS retry_attempts int NOT NULL DEFAULT 0 CHECK(retry_attempts BETWEEN 0 AND 5);
ALTER TABLE hex_observation ADD COLUMN IF NOT EXISTS retry_due timestamptz;
ALTER TABLE hex_observation ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
ALTER TABLE hex_observation ADD COLUMN IF NOT EXISTS retry_state text NOT NULL DEFAULT 'ready' CHECK(retry_state IN ('ready','parked','done'));
ALTER TABLE hex_observation ADD COLUMN IF NOT EXISTS retry_reason text;
