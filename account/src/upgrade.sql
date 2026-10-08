-- Additive upgrade of this lab only. Target/role guards run before this file.
CREATE TABLE IF NOT EXISTS reconcile_attempt (
 event_id text PRIMARY KEY REFERENCES fake_provider.record(event_id),
 attempts int NOT NULL DEFAULT 0, next_at timestamptz NOT NULL DEFAULT now(),
 state text NOT NULL DEFAULT 'retry' CHECK(state IN ('retry','done','needs_review')),
 reason text, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS status_version bigint NOT NULL DEFAULT 0;
ALTER TABLE payment_identity ADD COLUMN IF NOT EXISTS refund_seen boolean NOT NULL DEFAULT false;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS last_error text;
GRANT SELECT,INSERT,UPDATE,DELETE ON reconcile_attempt TO lab_runtime;
