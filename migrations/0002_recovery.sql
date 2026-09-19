-- Durable cutoffs for the only inputs that may lag canonical commits. Session snapshot
-- users hold advisory lock (4243,0) shared; prune/import take it exclusively.
CREATE TABLE hdd.recovery_pins (
 chain_id integer NOT NULL REFERENCES hdd.chains,
 purpose text NOT NULL CHECK(purpose IN ('transfer_consumer','recovery','backup','export')),
 block_number bigint NOT NULL CHECK(block_number>=0),
 PRIMARY KEY(chain_id,purpose)
);
GRANT SELECT ON hdd.recovery_pins TO hdd_v2_api,hdd_v2_worker;
GRANT INSERT,UPDATE,DELETE ON hdd.recovery_pins TO hdd_v2_worker;
-- Portable imports preserve before-image sequence identities and resume above their max.
GRANT UPDATE ON SEQUENCE hdd.undo_recent_sequence_seq TO hdd_v2_worker;
CREATE TABLE hdd.source_history (
 chain_id integer PRIMARY KEY REFERENCES hdd.chains,
 start_block bigint NOT NULL CHECK(start_block>=0), start_hash hdd.hash NOT NULL,
 start_time bigint NOT NULL, sources jsonb NOT NULL, finality_policy jsonb NOT NULL
);
GRANT SELECT ON hdd.source_history TO hdd_v2_api,hdd_v2_worker;
GRANT INSERT,UPDATE,DELETE ON hdd.source_history TO hdd_v2_worker;
