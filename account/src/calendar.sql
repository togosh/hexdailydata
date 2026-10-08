-- Apply after the existing account, HEX, period and metering installers. Additive
-- metadata defaults identify history explicitly; no existing dates/counters change.
CREATE OR REPLACE FUNCTION calendar_boundary(a timestamptz,n integer) RETURNS timestamptz
LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT (date_trunc('month',a AT TIME ZONE 'UTC')+make_interval(months=>n)
   +(least(extract(day FROM a AT TIME ZONE 'UTC')::int,
     extract(day FROM date_trunc('month',a AT TIME ZONE 'UTC')+make_interval(months=>n+1)-interval '1 day')::int)-1)*interval '1 day'
   +((a AT TIME ZONE 'UTC')-date_trunc('day',a AT TIME ZONE 'UTC'))) AT TIME ZONE 'UTC'
$$;
ALTER TABLE grant_record ADD COLUMN IF NOT EXISTS term_kind text NOT NULL DEFAULT 'fixed30';
ALTER TABLE grant_record ADD COLUMN IF NOT EXISTS calendar_anchor timestamptz;
ALTER TABLE grant_record ADD COLUMN IF NOT EXISTS calendar_index integer;
ALTER TABLE grant_record ADD COLUMN IF NOT EXISTS calendar_months integer;
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS term_kind text NOT NULL DEFAULT 'fixed30';
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS calendar_months integer;
ALTER TABLE invoice DROP CONSTRAINT IF EXISTS invoice_check;
ALTER TABLE invoice ADD CONSTRAINT invoice_check CHECK (
 (term_kind='fixed30' AND calendar_months IS NULL AND ((mode IN ('pls','hex') AND days IS NOT NULL) OR (mode='card' AND period_start<period_end))) OR
 (term_kind='calendar-v1' AND mode='hex' AND days IS NULL AND calendar_months IS NOT NULL AND calendar_months IN(1,12)));
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='grant_record'::regclass AND conname='calendar_term_shape') THEN
 ALTER TABLE grant_record ADD CONSTRAINT calendar_term_shape CHECK (
 (term_kind='fixed30' AND calendar_anchor IS NULL AND calendar_index IS NULL AND calendar_months IS NULL) OR
 (term_kind='calendar-v1' AND mode='hex' AND activated_at IS NOT NULL AND calendar_anchor IS NOT NULL AND calendar_index IS NOT NULL AND calendar_index>=0 AND calendar_months IS NOT NULL AND calendar_months IN(1,12)
  AND starts_at=calendar_boundary(calendar_anchor,calendar_index) AND ends_at=calendar_boundary(calendar_anchor,calendar_index+calendar_months)));
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS allowance_window (
 id uuid PRIMARY KEY, account_id text NOT NULL, term_id uuid NOT NULL, ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 11),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
 allowance integer NOT NULL CHECK(allowance>0),threshold integer NOT NULL CHECK(threshold BETWEEN 1 AND allowance),
 UNIQUE(term_id,ordinal),UNIQUE(account_id,term_id,id),FOREIGN KEY(account_id,term_id) REFERENCES grant_record(account_id,id)
);
CREATE TABLE IF NOT EXISTS window_usage (
 account_id text NOT NULL,term_id uuid NOT NULL,window_id uuid NOT NULL,used integer NOT NULL CHECK(used BETWEEN 0 AND 2147483647),
 PRIMARY KEY(account_id,term_id,window_id),FOREIGN KEY(account_id,term_id,window_id) REFERENCES allowance_window(account_id,term_id,id)
);
ALTER TABLE meter_receipt ADD COLUMN IF NOT EXISTS window_id uuid;
ALTER TABLE meter_receipt DROP CONSTRAINT IF EXISTS meter_period_owner;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='meter_receipt'::regclass AND conname='meter_term_owner') THEN
 ALTER TABLE meter_receipt ADD CONSTRAINT meter_term_owner FOREIGN KEY(account_id,period_id) REFERENCES grant_record(account_id,id);
 ALTER TABLE meter_receipt ADD CONSTRAINT meter_window_owner FOREIGN KEY(account_id,period_id,window_id) REFERENCES window_usage(account_id,term_id,window_id);
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS meter_window_pending ON meter_receipt(account_id,window_id,expires_at) WHERE state='pending';
CREATE OR REPLACE FUNCTION enforce_calendar_term() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.term_kind,NEW.calendar_anchor,NEW.calendar_index,NEW.calendar_months) IS DISTINCT FROM ROW(OLD.term_kind,OLD.calendar_anchor,OLD.calendar_index,OLD.calendar_months)
 THEN RAISE EXCEPTION 'CALENDAR_TERM_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE OR REPLACE TRIGGER calendar_term_immutable BEFORE UPDATE OR DELETE ON grant_record FOR EACH ROW EXECUTE FUNCTION enforce_calendar_term();
CREATE OR REPLACE FUNCTION enforce_calendar_invoice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.term_kind,NEW.calendar_months,NEW.days) IS DISTINCT FROM ROW(OLD.term_kind,OLD.calendar_months,OLD.days) THEN RAISE EXCEPTION 'CALENDAR_INVOICE_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE OR REPLACE TRIGGER calendar_invoice_immutable BEFORE UPDATE ON invoice FOR EACH ROW EXECUTE FUNCTION enforce_calendar_invoice();
CREATE OR REPLACE FUNCTION enforce_calendar_window() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE g grant_record; BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CALENDAR_WINDOW_IMMUTABLE';END IF;
 SELECT * INTO STRICT g FROM grant_record WHERE id=NEW.term_id AND account_id=NEW.account_id;
 IF g.term_kind<>'calendar-v1' OR NEW.ordinal>=g.calendar_months OR NEW.starts_at<>calendar_boundary(g.calendar_anchor,g.calendar_index+NEW.ordinal)
 OR NEW.ends_at<>calendar_boundary(g.calendar_anchor,g.calendar_index+NEW.ordinal+1) OR NEW.allowance<>g.allowance OR NEW.threshold<>g.reminder_threshold
 THEN RAISE EXCEPTION 'CALENDAR_WINDOW_INVALID';END IF;RETURN NEW;END $$;
CREATE OR REPLACE TRIGGER calendar_window_immutable BEFORE INSERT OR UPDATE OR DELETE ON allowance_window FOR EACH ROW EXECUTE FUNCTION enforce_calendar_window();
CREATE OR REPLACE FUNCTION enforce_calendar_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE kind text; BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.window_id IS DISTINCT FROM OLD.window_id THEN RAISE EXCEPTION 'METER_WINDOW_IMMUTABLE';END IF;RETURN NEW;
 END IF;
 IF NEW.period_id IS NULL THEN
  IF NEW.window_id IS NOT NULL OR EXISTS(SELECT 1 FROM grant_record WHERE account_id=NEW.account_id AND term_kind='calendar-v1') THEN RAISE EXCEPTION 'CALENDAR_MODE_REQUIRED';END IF;
 ELSE
  SELECT term_kind INTO STRICT kind FROM grant_record WHERE id=NEW.period_id AND account_id=NEW.account_id;
  IF (kind='calendar-v1' AND NEW.window_id IS NULL) OR (kind='fixed30' AND (NEW.window_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM period_usage WHERE account_id=NEW.account_id AND period_id=NEW.period_id)))
  THEN RAISE EXCEPTION 'METER_WINDOW_REQUIRED';END IF;
 END IF;RETURN NEW;END $$;
CREATE OR REPLACE TRIGGER calendar_receipt_guard BEFORE INSERT OR UPDATE ON meter_receipt FOR EACH ROW EXECUTE FUNCTION enforce_calendar_receipt();
CREATE OR REPLACE FUNCTION refuse_calendar_daily_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM grant_record WHERE account_id=NEW.account_id AND term_kind='calendar-v1') AND NOT EXISTS(
  SELECT 1 FROM meter_receipt WHERE id::text=current_setting('app.settling_daily_receipt',true)
  AND account_id=NEW.account_id AND day=NEW.day AND period_id IS NULL AND state='pending')
 THEN RAISE EXCEPTION 'CALENDAR_MODE_REQUIRED';END IF;RETURN NEW;END $$;
CREATE OR REPLACE TRIGGER calendar_daily_guard BEFORE INSERT OR UPDATE ON usage_bucket FOR EACH ROW EXECUTE FUNCTION refuse_calendar_daily_usage();
CREATE OR REPLACE FUNCTION enforce_window_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.account_id,NEW.term_id,NEW.window_id) IS DISTINCT FROM ROW(OLD.account_id,OLD.term_id,OLD.window_id) THEN RAISE EXCEPTION 'WINDOW_USAGE_OWNER_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE OR REPLACE TRIGGER window_usage_owner BEFORE UPDATE ON window_usage FOR EACH ROW EXECUTE FUNCTION enforce_window_usage();
GRANT SELECT,INSERT ON allowance_window TO lab_runtime;
GRANT SELECT,INSERT,UPDATE ON window_usage TO lab_runtime;
