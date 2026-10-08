-- Additive installation-wide RPC policy. No financial tables are changed.
CREATE TABLE IF NOT EXISTS payment_budget_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 boundary text NOT NULL, config jsonb NOT NULL
);
CREATE OR REPLACE FUNCTION payment_budget_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'PAYMENT_BUDGET_IMMUTABLE'; END $$;
CREATE OR REPLACE TRIGGER payment_budget_immutable BEFORE UPDATE OR DELETE ON payment_budget_policy
 FOR EACH ROW EXECUTE FUNCTION payment_budget_immutable();
CREATE TABLE IF NOT EXISTS payment_budget_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), highest_day date, highest_time timestamptz
);
INSERT INTO payment_budget_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS payment_budget_day (
 day date NOT NULL, slot integer NOT NULL CHECK(slot BETWEEN -1 AND 1),
 calls bigint NOT NULL CHECK(calls BETWEEN 0 AND 9007199254740991),
 bytes bigint NOT NULL CHECK(bytes BETWEEN 0 AND 9007199254740991), PRIMARY KEY(day,slot)
);
CREATE TABLE IF NOT EXISTS payment_budget_pending (
 token uuid PRIMARY KEY, day date NOT NULL, slot integer NOT NULL CHECK(slot IN(0,1)),
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_budget_pending_expiry ON payment_budget_pending(expires_at);
-- Same database clock authority as databaseTime; tests replace this function
-- only as the guarded migrator, with one shared SQL fixture clock.
CREATE OR REPLACE FUNCTION payment_budget_now() RETURNS timestamptz LANGUAGE sql VOLATILE
 AS $$ SELECT clock_timestamp() $$;
REVOKE ALL ON payment_budget_policy,payment_budget_state,payment_budget_day,payment_budget_pending FROM PUBLIC;
GRANT SELECT ON payment_budget_policy TO lab_runtime;
GRANT SELECT,UPDATE ON payment_budget_state TO lab_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON payment_budget_day TO lab_runtime;
GRANT SELECT,INSERT,DELETE ON payment_budget_pending TO lab_runtime;
REVOKE ALL ON FUNCTION payment_budget_now() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payment_budget_now() TO lab_runtime;
