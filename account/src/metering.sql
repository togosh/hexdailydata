-- Additive account-only candidate. Run through installMetering after identity checks.
CREATE TABLE IF NOT EXISTS meter_receipt (
 id uuid PRIMARY KEY,
 account_id text NOT NULL REFERENCES customer(id),
 day date NOT NULL,
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 state text NOT NULL CHECK (state IN ('pending','success','released','expired')),
 terminal_at timestamptz,
 route text NOT NULL CHECK (route IN ('home','daily','stakes','stakeEvents')),
 method text NOT NULL CHECK (method IN ('GET','HEAD')),
 status integer CHECK (status BETWEEN 100 AND 599),
 reason text CHECK (reason IN ('completed','error','disconnect','uncertain','expired')),
 CHECK (expires_at > created_at),
 CHECK ((state='pending' AND terminal_at IS NULL AND reason IS NULL) OR
        (state<>'pending' AND terminal_at IS NOT NULL AND reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS meter_account_pending ON meter_receipt(account_id,day,expires_at) WHERE state='pending';
CREATE INDEX IF NOT EXISTS meter_expiry ON meter_receipt(expires_at,id) WHERE state='pending';
CREATE INDEX IF NOT EXISTS meter_retention ON meter_receipt(terminal_at,id) WHERE state<>'pending';
GRANT SELECT,INSERT,UPDATE,DELETE ON meter_receipt TO lab_runtime;
