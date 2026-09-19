-- Disposable current overlays do not depend on canonical bootstrap or its writer lock.
CREATE TABLE hdd.live_metrics (
 chain_id integer NOT NULL CHECK (chain_id IN (1,369)),
 metric text NOT NULL CHECK (metric IN ('price','shareRate','todayPayoutEstimate','latestCompletedPayout')),
 observation jsonb NOT NULL CHECK (jsonb_typeof(observation)='object' AND octet_length(observation::text)<=16384),
 inputs jsonb NOT NULL CHECK (jsonb_typeof(inputs)='object' AND octet_length(inputs::text)<=16384),
 PRIMARY KEY(chain_id,metric)
);
GRANT SELECT ON hdd.live_metrics TO hdd_v2_api,hdd_v2_worker;
GRANT INSERT,UPDATE,DELETE ON hdd.live_metrics TO hdd_v2_worker;
