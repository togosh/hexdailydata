-- Independent overlays leave canonical rows and retained before-images unchanged.
CREATE TABLE hdd.rank_state (
 chain_id integer PRIMARY KEY REFERENCES hdd.chains,
 block_number bigint NOT NULL, block_hash hdd.hash NOT NULL, block_time bigint NOT NULL,
 revision bigint NOT NULL, ranking_day integer NOT NULL CHECK(ranking_day BETWEEN 0 AND 65535)
);
CREATE TABLE hdd.account_ranks (
 chain_id integer NOT NULL REFERENCES hdd.chains, address hdd.address NOT NULL,
 liquid_rank bigint CHECK(liquid_rank>0), staker_rank bigint CHECK(staker_rank>0),
 PRIMARY KEY(chain_id,address), CHECK(liquid_rank IS NOT NULL OR staker_rank IS NOT NULL),
 UNIQUE(chain_id,liquid_rank) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(chain_id,staker_rank) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE hdd.market_sources (
 chain_id integer NOT NULL CHECK(chain_id IN(1,369)), source text NOT NULL CHECK(source ~ '^[a-z][a-z0-9_-]{0,63}$'),
 method text NOT NULL CHECK(method IN('sampled-ohlc','source-reported')),
 native boolean NOT NULL, qualification text NOT NULL CHECK(qualification IN('peg_assumed','source_reported_usd')),
 from_day integer NOT NULL CHECK(from_day BETWEEN 0 AND 65535), through_day integer,
 dirty_day integer, sample_bytes bigint NOT NULL DEFAULT 0 CHECK(sample_bytes>=0),
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 capture_status text NOT NULL DEFAULT 'ready' CHECK(capture_status IN('ready','byte_pressure','capture_error')),
 PRIMARY KEY(chain_id,source),
 CHECK(through_day IS NULL OR through_day BETWEEN from_day AND 65535),
 CHECK(dirty_day IS NULL OR dirty_day BETWEEN from_day AND 65535),
 CHECK((method='sampled-ohlc' AND native AND qualification='peg_assumed') OR
       (method='source-reported' AND NOT native AND qualification='source_reported_usd'))
);
-- One event per source identity; poll time never participates in identity/coverage.
CREATE TABLE hdd.market_samples (
 chain_id integer NOT NULL, source text NOT NULL, identity text NOT NULL CHECK(identity ~ '^[a-zA-Z0-9:_-]{1,160}$'),
 source_time bigint NOT NULL CHECK(source_time>=1575331200), observed_time bigint NOT NULL CHECK(observed_time>=source_time),
 block_number bigint, block_hash hdd.hash, pool_time bigint,
 contract_day integer NOT NULL CHECK(contract_day BETWEEN 0 AND 65535),
 interval_number integer NOT NULL CHECK(interval_number BETWEEN 0 AND 1439),
 observation jsonb NOT NULL CHECK(octet_length(observation::text)<=4096),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 PRIMARY KEY(chain_id,source,identity), FOREIGN KEY(chain_id,source) REFERENCES hdd.market_sources,
 CHECK(contract_day=(source_time-1575331200)/86400),
 CHECK(interval_number=mod(source_time-1575331200,86400)/60)
);
CREATE INDEX market_interval ON hdd.market_samples(chain_id,source,contract_day,source_time,identity);
CREATE TABLE hdd.market_daily (
 chain_id integer NOT NULL, source text NOT NULL, contract_day integer NOT NULL CHECK(contract_day BETWEEN 0 AND 65535),
 observation jsonb NOT NULL CHECK(octet_length(observation::text)<=8192),
 PRIMARY KEY(chain_id,source,contract_day), FOREIGN KEY(chain_id,source) REFERENCES hdd.market_sources
);
CREATE TABLE hdd.export_bundles (
 id uuid PRIMARY KEY, chain_id integer NOT NULL REFERENCES hdd.chains,
 slot text NOT NULL CHECK(slot IN('current','prior')), status text NOT NULL CHECK(status IN('available','unavailable')),
 manifest jsonb NOT NULL CHECK(octet_length(manifest::text)<=32768),
 published_at timestamptz NOT NULL DEFAULT now(), UNIQUE(chain_id,slot)
);
-- Rewind invalidates derived native overlays atomically. Independent market history survives.
CREATE FUNCTION hdd.invalidate_daily() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.block_number<OLD.block_number OR
    (NEW.block_number=OLD.block_number AND NEW.block_hash<>OLD.block_hash) THEN
  DELETE FROM hdd.account_ranks WHERE chain_id=NEW.chain_id;
  DELETE FROM hdd.rank_state WHERE chain_id=NEW.chain_id;
  NEW.ranking_day := NULL;
  UPDATE hdd.market_sources s SET dirty_day=least(s.dirty_day,q.day)
   FROM (SELECT m.source,min(m.contract_day) AS day FROM hdd.market_samples m
     JOIN hdd.market_sources p USING(chain_id,source)
     WHERE m.chain_id=NEW.chain_id AND p.native AND (m.block_number>NEW.block_number OR
       (m.block_number=NEW.block_number AND m.block_hash<>NEW.block_hash)) GROUP BY m.source) q
   WHERE s.chain_id=NEW.chain_id AND s.source=q.source;
  -- Aggregated native days can outlive samples. Invalidate the entire affected suffix.
  DELETE FROM hdd.market_daily m USING hdd.market_sources p WHERE m.chain_id=NEW.chain_id
    AND p.chain_id=m.chain_id AND p.source=m.source AND p.native
    AND m.contract_day >= (NEW.block_time-1575331200)/86400;
  UPDATE hdd.market_sources SET dirty_day=least(dirty_day,greatest(from_day,((NEW.block_time-1575331200)/86400)::integer)),
    through_day=CASE WHEN (NEW.block_time-1575331200)/86400<=from_day THEN NULL
      ELSE least(through_day,((NEW.block_time-1575331200)/86400)::integer-1) END,version=version+1
    WHERE chain_id=NEW.chain_id AND native;
  DELETE FROM hdd.market_samples m USING hdd.market_sources p WHERE m.chain_id=NEW.chain_id
    AND p.chain_id=m.chain_id AND p.source=m.source AND p.native AND
    (m.block_number>NEW.block_number OR (m.block_number=NEW.block_number AND m.block_hash<>NEW.block_hash));
  UPDATE hdd.market_sources s SET sample_bytes=(SELECT coalesce(sum(pg_column_size(m)),0)
    FROM hdd.market_samples m WHERE m.chain_id=s.chain_id AND m.source=s.source) WHERE s.chain_id=NEW.chain_id;
  UPDATE hdd.export_bundles SET status='unavailable' WHERE chain_id=NEW.chain_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invalidate_daily BEFORE UPDATE ON hdd.sync_state FOR EACH ROW EXECUTE FUNCTION hdd.invalidate_daily();
REVOKE ALL ON FUNCTION hdd.invalidate_daily() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hdd.invalidate_daily() TO hdd_v2_worker;
GRANT SELECT ON hdd.rank_state,hdd.account_ranks,hdd.market_sources,hdd.market_samples,hdd.market_daily,hdd.export_bundles TO hdd_v2_api,hdd_v2_worker;
GRANT INSERT,UPDATE,DELETE ON hdd.rank_state,hdd.account_ranks,hdd.market_sources,hdd.market_samples,hdd.market_daily,hdd.export_bundles TO hdd_v2_worker;
