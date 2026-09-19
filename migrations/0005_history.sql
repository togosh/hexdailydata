-- Attributed archive independent of native initialization and undo. No chains FK.
CREATE TABLE hdd.history_source (
 source text PRIMARY KEY CHECK(source='hexdailystats'),
 chain_id integer NOT NULL CHECK(chain_id=369),
 revision uuid NOT NULL,
 metadata jsonb NOT NULL CHECK(octet_length(metadata::text)<=16384)
);
CREATE TABLE hdd.history_daily (
 source text NOT NULL REFERENCES hdd.history_source,
 source_day integer NOT NULL CHECK(source_day BETWEEN 0 AND 65535),
 record_date date NOT NULL,
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=16384),
 PRIMARY KEY(source,source_day),
 CHECK((payload->>'sourceDay')::integer=source_day),
 CHECK((payload->>'sourceRecordDateUtc')::date=record_date)
);
CREATE INDEX history_date ON hdd.history_daily(source,record_date,source_day);
GRANT SELECT ON hdd.history_source,hdd.history_daily TO hdd_v2_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON hdd.history_source,hdd.history_daily TO hdd_v2_worker;
