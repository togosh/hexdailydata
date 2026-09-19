-- Version 1: fresh v2 targets only. Transaction and ledger owned by migrate.ts.
CREATE SCHEMA hdd;
CREATE DOMAIN hdd.address AS bytea CHECK (octet_length(VALUE)=20);
CREATE DOMAIN hdd.hash AS bytea CHECK (octet_length(VALUE)=32);
CREATE DOMAIN hdd.amount AS numeric CHECK (scale(VALUE)=0 AND VALUE>=0 AND VALUE<=115792089237316195423570985008687907853269984665640564039457584007913129639935);
-- Up to 2^63-1 positions, each uint256, times at most 5555 days fits 102 digits.
CREATE DOMAIN hdd.total AS numeric CHECK (scale(VALUE)=0 AND VALUE>=0 AND VALUE<power(10::numeric,102));
CREATE TABLE hdd.schema_migrations (version integer PRIMARY KEY, sha256 text NOT NULL);
CREATE TABLE hdd.chains (
 chain_id integer PRIMARY KEY CHECK(chain_id IN (1,369)),
 contract_address hdd.address NOT NULL, code_hash hdd.hash NOT NULL,
 initialization text NOT NULL CHECK(initialization IN ('constructor','fork')),
 origin_chain_id integer NOT NULL CHECK(origin_chain_id IN (1,369)),
 parent_block bigint, parent_hash hdd.hash, entry_block bigint, entry_hash hdd.hash,
 CHECK ((initialization='constructor' AND chain_id=1 AND origin_chain_id=1 AND parent_block IS NULL AND parent_hash IS NULL AND entry_block IS NULL AND entry_hash IS NULL)
 OR (initialization='fork' AND chain_id=369 AND origin_chain_id=369 AND parent_block>=0 AND parent_hash IS NOT NULL AND entry_block>parent_block AND entry_hash IS NOT NULL))
);
CREATE TABLE hdd.sync_state (
 chain_id integer PRIMARY KEY REFERENCES hdd.chains,
 block_number bigint NOT NULL CHECK(block_number>=0), block_hash hdd.hash NOT NULL,
 block_time bigint NOT NULL CHECK(block_time>=1575331200),
 revision bigint NOT NULL CHECK(revision>=0),
 finality text NOT NULL CHECK(finality IN ('confirmed','finalized')),
 rewind_floor bigint NOT NULL CHECK(rewind_floor>=0 AND rewind_floor<=block_number),
 acceptance jsonb NOT NULL,
 ranking_day integer CHECK(ranking_day BETWEEN 0 AND 65535)
);
CREATE TABLE hdd.current_state (
 chain_id integer PRIMARY KEY REFERENCES hdd.chains,
 contract_day integer NOT NULL CHECK(contract_day BETWEEN 0 AND 65535),
 circulating_hearts hdd.amount NOT NULL, locked_hearts hdd.total NOT NULL,
 accounted_hearts hdd.total NOT NULL, weighted_days hdd.total NOT NULL,
 active_shares hdd.total NOT NULL, queued_shares hdd.total NOT NULL,
 holder_count bigint NOT NULL CHECK(holder_count>=0), staker_count bigint NOT NULL CHECK(staker_count>=0),
 raw_share_rate hdd.amount NOT NULL CHECK(raw_share_rate>0),
 starts bigint NOT NULL CHECK(starts>=0), ends bigint NOT NULL CHECK(ends>=0),
 payout_recorded hdd.total NOT NULL, penalty_hearts hdd.total NOT NULL,
 sampled_addresses bytea[] NOT NULL DEFAULT '{}' CHECK(cardinality(sampled_addresses)<=32)
);
CREATE TABLE hdd.accounts (
 chain_id integer NOT NULL REFERENCES hdd.chains, address hdd.address NOT NULL,
 liquid_hearts hdd.amount NOT NULL, accounted_hearts hdd.total NOT NULL,
 stake_count bigint NOT NULL CHECK(stake_count>=0), first_block bigint NOT NULL CHECK(first_block>=0),
 last_block bigint NOT NULL CHECK(last_block>=first_block),
 PRIMARY KEY(chain_id,address)
);
CREATE TABLE hdd.stakes (
 chain_id integer NOT NULL REFERENCES hdd.chains, stake_id bigint NOT NULL CHECK(stake_id>=0),
 address hdd.address NOT NULL, origin_chain_id integer NOT NULL CHECK(origin_chain_id IN (1,369)),
 start_block bigint NOT NULL CHECK(start_block>=0), start_log integer NOT NULL CHECK(start_log>=0),
 start_day integer NOT NULL CHECK(start_day BETWEEN 0 AND 65535),
 locked_day integer NOT NULL CHECK(locked_day=greatest(start_day+1,2)),
 staked_days integer NOT NULL CHECK(staked_days BETWEEN 1 AND 5555 AND locked_day+staked_days<=65535),
 principal_hearts hdd.amount NOT NULL CHECK(principal_hearts>0), stake_shares hdd.amount NOT NULL CHECK(stake_shares>0),
 is_auto_stake boolean NOT NULL,
 lifecycle text NOT NULL CHECK(lifecycle IN ('unsettled','good_accounted','ended','cancelled')),
 ga_day integer, ga_block bigint, end_day integer, end_block bigint,
 payout_hearts hdd.amount, penalty_hearts hdd.amount,
 last_block bigint NOT NULL CHECK(last_block>=start_block),
 PRIMARY KEY(chain_id,stake_id),
 CHECK(NOT is_auto_stake OR (start_day BETWEEN 1 AND 350 AND staked_days>=350 AND (end_day IS NULL OR end_day>=locked_day+350))),
 CHECK((ga_day IS NULL AND ga_block IS NULL) OR (ga_day IS NOT NULL AND ga_block IS NOT NULL AND ga_day>=locked_day+staked_days AND ga_day<=65535 AND ga_block>=start_block AND ga_block<=last_block)),
 CHECK((lifecycle='unsettled' AND ga_day IS NULL AND end_day IS NULL AND end_block IS NULL AND payout_hearts IS NULL AND penalty_hearts IS NULL)
 OR (lifecycle='good_accounted' AND ga_day IS NOT NULL AND end_day IS NULL AND end_block IS NULL AND payout_hearts IS NOT NULL AND penalty_hearts IS NOT NULL)
 OR (lifecycle IN ('ended','cancelled') AND end_day IS NOT NULL AND end_block IS NOT NULL AND end_day BETWEEN start_day AND 65535 AND end_block>=start_block AND end_block<=last_block AND payout_hearts IS NOT NULL AND penalty_hearts IS NOT NULL
 AND (ga_day IS NULL OR (end_day>=ga_day AND end_block>=ga_block)) AND (lifecycle='cancelled')=(end_day<locked_day)
 AND (lifecycle<>'cancelled' OR (payout_hearts=0 AND penalty_hearts=0))))
);
CREATE INDEX stakes_address ON hdd.stakes(chain_id,address,stake_id);
CREATE INDEX stakes_maturity ON hdd.stakes(chain_id,(locked_day+staked_days),stake_id) WHERE lifecycle='unsettled';
CREATE TABLE hdd.share_schedule (
 chain_id integer NOT NULL REFERENCES hdd.chains, activation_day integer NOT NULL CHECK(activation_day BETWEEN 0 AND 65535),
 shares hdd.total NOT NULL, PRIMARY KEY(chain_id,activation_day)
);
CREATE TABLE hdd.daily_stats (
 chain_id integer NOT NULL REFERENCES hdd.chains, contract_day integer NOT NULL CHECK(contract_day BETWEEN 0 AND 65535),
 origin_chain_id integer NOT NULL CHECK(origin_chain_id IN (1,369)),
 close_block bigint NOT NULL CHECK(close_block>=0), close_hash hdd.hash NOT NULL,
 circulating_hearts hdd.amount NOT NULL, locked_hearts hdd.total NOT NULL,
 accounted_hearts hdd.total NOT NULL, weighted_days hdd.total NOT NULL,
 active_shares hdd.total NOT NULL, queued_shares hdd.total NOT NULL,
 holder_count bigint NOT NULL CHECK(holder_count>=0), staker_count bigint NOT NULL CHECK(staker_count>=0),
 raw_share_rate hdd.amount NOT NULL CHECK(raw_share_rate>0), starts bigint NOT NULL CHECK(starts>=0), ends bigint NOT NULL CHECK(ends>=0),
 payout_recorded hdd.total NOT NULL, penalty_hearts hdd.total NOT NULL,
 payout_status text NOT NULL DEFAULT 'pending' CHECK(payout_status IN ('pending','materialized')),
 payout_hearts hdd.amount, payout_shares hdd.amount, payout_block bigint, payout_hash hdd.hash,
 PRIMARY KEY(chain_id,contract_day),
 CHECK((payout_status='pending' AND payout_hearts IS NULL AND payout_shares IS NULL AND payout_block IS NULL AND payout_hash IS NULL)
 OR (payout_status='materialized' AND payout_hearts IS NOT NULL AND payout_shares IS NOT NULL AND payout_block>=close_block AND payout_hash IS NOT NULL))
);
CREATE TABLE hdd.blocks_recent (
 chain_id integer NOT NULL REFERENCES hdd.chains, number bigint NOT NULL CHECK(number>=0),
 hash hdd.hash NOT NULL, parent_hash hdd.hash NOT NULL, timestamp bigint NOT NULL CHECK(timestamp>=1575331200),
 PRIMARY KEY(chain_id,number)
);
-- Original chain identity is retained once, even when state is inherited by PulseChain.
CREATE TABLE hdd.events (
 origin_chain_id integer NOT NULL CHECK(origin_chain_id IN (1,369)), block_number bigint NOT NULL CHECK(block_number>=0),
 log_index integer NOT NULL CHECK(log_index>=0), block_hash hdd.hash NOT NULL, transaction_hash hdd.hash NOT NULL,
 transaction_index integer NOT NULL CHECK(transaction_index>=0), block_time bigint NOT NULL,
 kind text NOT NULL CHECK(kind IN ('stake_start','stake_end','good_accounting','share_rate','daily_update','claim')),
 stake_id bigint, topics bytea[] NOT NULL, data bytea NOT NULL, payload jsonb NOT NULL,
 PRIMARY KEY(origin_chain_id,block_number,log_index)
);
CREATE INDEX events_stake ON hdd.events(origin_chain_id,stake_id,block_number,log_index) WHERE stake_id IS NOT NULL;
CREATE TABLE hdd.transfers_recent (
 origin_chain_id integer NOT NULL CHECK(origin_chain_id IN (1,369)), block_number bigint NOT NULL CHECK(block_number>=0),
 log_index integer NOT NULL CHECK(log_index>=0), block_hash hdd.hash NOT NULL, transaction_hash hdd.hash NOT NULL,
 transaction_index integer NOT NULL CHECK(transaction_index>=0), block_time bigint NOT NULL,
 sender hdd.address NOT NULL, recipient hdd.address NOT NULL, hearts hdd.amount NOT NULL,
 topics bytea[] NOT NULL, data bytea NOT NULL, payload jsonb NOT NULL,
 PRIMARY KEY(origin_chain_id,block_number,log_index)
);
CREATE TABLE hdd.checkpoints_recent (
 chain_id integer NOT NULL REFERENCES hdd.chains, revision bigint NOT NULL,
 block_number bigint NOT NULL, block_time bigint NOT NULL, batch_digest text NOT NULL,
 previous_sync jsonb NOT NULL, undo_bytes bigint NOT NULL DEFAULT 0 CHECK(undo_bytes>=0), tail_bytes bigint NOT NULL DEFAULT 0 CHECK(tail_bytes>=0),
 PRIMARY KEY(chain_id,revision), UNIQUE(chain_id,block_number)
);
CREATE TABLE hdd.undo_recent (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 chain_id integer NOT NULL, revision bigint NOT NULL,
 relation_name text NOT NULL CHECK(relation_name IN ('accounts','stakes','current_state','share_schedule','daily_stats','events','transfers_recent','blocks_recent')),
 row_key jsonb NOT NULL, previous_value jsonb,
 FOREIGN KEY(chain_id,revision) REFERENCES hdd.checkpoints_recent ON DELETE CASCADE
);
CREATE INDEX undo_checkpoint ON hdd.undo_recent(chain_id,revision,sequence DESC);
-- Fixed projection table triggers record exact SQL numeric JSON. It never crosses a JS Number.
CREATE FUNCTION hdd.capture_undo() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb; k jsonb := '{}'; col text; chain integer; rev bigint;
BEGIN
 IF current_setting('hdd.rewinding',true)='yes' THEN RETURN NULL; END IF;
 chain := nullif(current_setting('hdd.chain',true),'')::integer;
 rev := nullif(current_setting('hdd.revision',true),'')::bigint;
 -- Initialization is a separate empty-target transaction without a rewind predecessor.
 IF rev IS NULL THEN RETURN NULL; END IF;
 r := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 FOREACH col IN ARRAY TG_ARGV LOOP k := k || jsonb_build_object(col,r->col); END LOOP;
 INSERT INTO hdd.undo_recent(chain_id,revision,relation_name,row_key,previous_value)
 VALUES(chain,rev,TG_TABLE_NAME,k,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END);
 RETURN NULL;
END $$;
CREATE TRIGGER undo AFTER INSERT OR UPDATE OR DELETE ON hdd.accounts FOR EACH ROW EXECUTE FUNCTION hdd.capture_undo('chain_id','address');
CREATE TRIGGER undo AFTER INSERT OR UPDATE OR DELETE ON hdd.stakes FOR EACH ROW EXECUTE FUNCTION hdd.capture_undo('chain_id','stake_id');
CREATE TRIGGER undo AFTER INSERT OR UPDATE OR DELETE ON hdd.current_state FOR EACH ROW EXECUTE FUNCTION hdd.capture_undo('chain_id');
CREATE TRIGGER undo AFTER INSERT OR UPDATE OR DELETE ON hdd.share_schedule FOR EACH ROW EXECUTE FUNCTION hdd.capture_undo('chain_id','activation_day');
CREATE TRIGGER undo AFTER INSERT OR UPDATE OR DELETE ON hdd.daily_stats FOR EACH ROW EXECUTE FUNCTION hdd.capture_undo('chain_id','contract_day');
CREATE TRIGGER undo AFTER INSERT OR UPDATE OR DELETE ON hdd.events FOR EACH ROW EXECUTE FUNCTION hdd.capture_undo('origin_chain_id','block_number','log_index');
CREATE TRIGGER undo AFTER INSERT OR UPDATE OR DELETE ON hdd.transfers_recent FOR EACH ROW EXECUTE FUNCTION hdd.capture_undo('origin_chain_id','block_number','log_index');
CREATE TRIGGER undo AFTER INSERT OR UPDATE OR DELETE ON hdd.blocks_recent FOR EACH ROW EXECUTE FUNCTION hdd.capture_undo('chain_id','number');
REVOKE ALL ON SCHEMA hdd FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hdd FROM PUBLIC;
GRANT USAGE ON SCHEMA hdd TO hdd_v2_api,hdd_v2_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA hdd TO hdd_v2_api,hdd_v2_worker;
GRANT INSERT,UPDATE,DELETE ON hdd.chains,hdd.sync_state,hdd.current_state,hdd.accounts,hdd.stakes,hdd.share_schedule,hdd.daily_stats,hdd.blocks_recent,hdd.events,hdd.transfers_recent,hdd.checkpoints_recent,hdd.undo_recent TO hdd_v2_worker;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA hdd TO hdd_v2_worker;
GRANT EXECUTE ON FUNCTION hdd.capture_undo() TO hdd_v2_worker;
