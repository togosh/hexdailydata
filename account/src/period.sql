-- Disposable account candidate only; guarded by installPeriods.
ALTER TABLE grant_record ADD COLUMN IF NOT EXISTS activated_at timestamptz;
ALTER TABLE grant_record ADD COLUMN IF NOT EXISTS plan_revision text;
ALTER TABLE grant_record ADD COLUMN IF NOT EXISTS allowance integer;
ALTER TABLE grant_record ADD COLUMN IF NOT EXISTS reminder_threshold integer;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='grant_record'::regclass AND conname='period_terms') THEN
 ALTER TABLE grant_record ADD CONSTRAINT period_terms CHECK (
 (activated_at IS NULL AND plan_revision IS NULL AND allowance IS NULL AND reminder_threshold IS NULL) OR
 (activated_at IS NOT NULL AND activated_at<ends_at AND plan_revision IS NOT NULL AND length(plan_revision) BETWEEN 1 AND 100 AND
 allowance IS NOT NULL AND allowance BETWEEN 1 AND 2147483647 AND reminder_threshold IS NOT NULL AND reminder_threshold BETWEEN 1 AND allowance));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='grant_record'::regclass AND conname='period_owner') THEN
 ALTER TABLE grant_record ADD CONSTRAINT period_owner UNIQUE(account_id,id);
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS period_usage (
 account_id text NOT NULL,
 period_id uuid NOT NULL,
 used integer NOT NULL CHECK(used BETWEEN 0 AND 2147483647),
 PRIMARY KEY(account_id,period_id),
 FOREIGN KEY(account_id,period_id) REFERENCES grant_record(account_id,id)
);
ALTER TABLE meter_receipt ALTER COLUMN day DROP NOT NULL;
ALTER TABLE meter_receipt ADD COLUMN IF NOT EXISTS period_id uuid;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='meter_receipt'::regclass AND conname='meter_owner_shape') THEN
 ALTER TABLE meter_receipt ADD CONSTRAINT meter_owner_shape CHECK ((day IS NOT NULL AND period_id IS NULL) OR (day IS NULL AND period_id IS NOT NULL));
 ALTER TABLE meter_receipt ADD CONSTRAINT meter_period_owner FOREIGN KEY(account_id,period_id) REFERENCES period_usage(account_id,period_id);
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS meter_period_pending ON meter_receipt(account_id,period_id,expires_at) WHERE state='pending';
GRANT SELECT,INSERT,UPDATE ON period_usage TO lab_runtime;
-- A legacy grant cannot acquire a fresh allowance by annotation. Create a new
-- grant through the internal writer; once enabled its ownership/terms are fixed.
CREATE OR REPLACE FUNCTION enforce_period_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL) OR
    (OLD.activated_at IS NOT NULL AND ROW(NEW.id,NEW.account_id,NEW.payment_id,NEW.mode,NEW.starts_at,NEW.ends_at,NEW.activated_at,NEW.plan_revision,NEW.allowance,NEW.reminder_threshold)
      IS DISTINCT FROM ROW(OLD.id,OLD.account_id,OLD.payment_id,OLD.mode,OLD.starts_at,OLD.ends_at,OLD.activated_at,OLD.plan_revision,OLD.allowance,OLD.reminder_threshold)) THEN
   RAISE EXCEPTION 'PERIOD_TERMS_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER immutable_period_terms BEFORE UPDATE ON grant_record FOR EACH ROW EXECUTE FUNCTION enforce_period_terms();
CREATE OR REPLACE FUNCTION enforce_receipt_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.account_id,NEW.day,NEW.period_id) IS DISTINCT FROM ROW(OLD.id,OLD.account_id,OLD.day,OLD.period_id) THEN
   RAISE EXCEPTION 'METER_OWNER_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER immutable_receipt_owner BEFORE UPDATE ON meter_receipt FOR EACH ROW EXECUTE FUNCTION enforce_receipt_owner();
