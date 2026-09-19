-- INITIAL SCHEMA CONTRACT: not applied or production-qualified by this starter.
-- Task02 refines/tests with a v2-only migration runner and role/target guards.
-- Normalized events grow with events. Current projections have no per-day copies.
-- Recent transfer/undo/header tails are bounded. Export manifests retain current+prior.
BEGIN;
CREATE SCHEMA hdd;

CREATE TABLE hdd.chains (
  chain_id integer PRIMARY KEY CHECK (chain_id IN (1, 369)),
  name text NOT NULL UNIQUE,
  contract_address bytea NOT NULL CHECK (octet_length(contract_address) = 20),
  code_sha256 bytea NOT NULL CHECK (octet_length(code_sha256) = 32),
  first_block bigint NOT NULL CHECK (first_block >= 0),
  parent_chain_id integer REFERENCES hdd.chains,
  parent_block bigint,
  parent_block_hash bytea
);

CREATE TABLE hdd.sync_state (
  chain_id integer NOT NULL REFERENCES hdd.chains,
  stream text NOT NULL CHECK (stream IN ('native', 'daily', 'market')),
  block_number bigint NOT NULL,
  block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
  block_time timestamptz NOT NULL,
  finality text NOT NULL CHECK (finality IN ('finalized', 'confirmed')),
  state text NOT NULL CHECK (state IN ('syncing', 'current', 'degraded', 'paused')),
  revision bigint NOT NULL DEFAULT 0,
  progress jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, stream)
);

CREATE TABLE hdd.blocks_recent (
  chain_id integer NOT NULL REFERENCES hdd.chains,
  number bigint NOT NULL,
  hash bytea NOT NULL CHECK (octet_length(hash) = 32),
  parent_hash bytea NOT NULL CHECK (octet_length(parent_hash) = 32),
  timestamp timestamptz NOT NULL,
  PRIMARY KEY (chain_id, number)
);

CREATE TABLE hdd.events (
  origin_chain_id integer NOT NULL REFERENCES hdd.chains,
  block_number bigint NOT NULL,
  block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
  transaction_hash bytea NOT NULL CHECK (octet_length(transaction_hash) = 32),
  transaction_index integer NOT NULL CHECK (transaction_index >= 0),
  log_index integer NOT NULL CHECK (log_index >= 0),
  block_time timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('stake_start', 'stake_end', 'good_accounting', 'share_rate', 'daily_update', 'claim')),
  stake_id bigint,
  staker bytea CHECK (staker IS NULL OR octet_length(staker) = 20),
  topics bytea[] NOT NULL,
  data bytea NOT NULL,
  PRIMARY KEY (origin_chain_id, block_number, log_index)
);

CREATE TABLE hdd.transfers_recent (
  origin_chain_id integer NOT NULL REFERENCES hdd.chains,
  block_number bigint NOT NULL,
  block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
  transaction_hash bytea NOT NULL CHECK (octet_length(transaction_hash) = 32),
  log_index integer NOT NULL,
  block_time timestamptz NOT NULL,
  sender bytea NOT NULL CHECK (octet_length(sender) = 20),
  recipient bytea NOT NULL CHECK (octet_length(recipient) = 20),
  hearts numeric(78,0) NOT NULL CHECK (hearts >= 0),
  PRIMARY KEY (origin_chain_id, block_number, log_index)
);

CREATE TABLE hdd.undo_recent (
  chain_id integer NOT NULL REFERENCES hdd.chains,
  block_number bigint NOT NULL,
  sequence integer NOT NULL,
  block_time timestamptz NOT NULL,
  relation_name text NOT NULL CHECK (relation_name IN ('stakes', 'accounts', 'daily_stats')),
  row_key jsonb NOT NULL,
  previous_value jsonb,
  PRIMARY KEY (chain_id, block_number, sequence)
);

CREATE TABLE hdd.stakes (
  chain_id integer NOT NULL REFERENCES hdd.chains,
  stake_id bigint NOT NULL CHECK (stake_id >= 0),
  address bytea NOT NULL CHECK (octet_length(address) = 20),
  principal_hearts numeric(78,0) NOT NULL CHECK (principal_hearts >= 0),
  stake_shares numeric(78,0) NOT NULL CHECK (stake_shares >= 0),
  locked_day integer NOT NULL CHECK (locked_day >= 0),
  staked_days integer NOT NULL CHECK (staked_days BETWEEN 1 AND 5555),
  is_auto_stake boolean NOT NULL,
  origin_chain_id integer NOT NULL REFERENCES hdd.chains,
  start_block bigint NOT NULL,
  start_log_index integer NOT NULL,
  started_at timestamptz NOT NULL,
  good_accounting_block bigint,
  good_accounting_log_index integer,
  good_accounting_at timestamptz,
  end_block bigint,
  end_log_index integer,
  ended_at timestamptz,
  payout_hearts numeric(78,0) CHECK (payout_hearts >= 0),
  penalty_hearts numeric(78,0) CHECK (penalty_hearts >= 0),
  last_changed_block bigint NOT NULL,
  PRIMARY KEY (chain_id, stake_id)
);

CREATE TABLE hdd.accounts (
  chain_id integer NOT NULL REFERENCES hdd.chains,
  address bytea NOT NULL CHECK (octet_length(address) = 20),
  liquid_hearts numeric(78,0) NOT NULL CHECK (liquid_hearts >= 0),
  accounted_staked_hearts numeric(78,0) NOT NULL CHECK (accounted_staked_hearts >= 0),
  accounted_stake_count integer NOT NULL CHECK (accounted_stake_count >= 0),
  first_seen_block bigint NOT NULL,
  last_changed_block bigint NOT NULL,
  liquid_rank integer,
  staker_rank integer,
  rank_day integer,
  PRIMARY KEY (chain_id, address)
);

CREATE TABLE hdd.daily_stats (
  chain_id integer NOT NULL REFERENCES hdd.chains,
  contract_day integer NOT NULL CHECK (contract_day >= 0),
  date_utc date NOT NULL,
  origin_chain_id integer NOT NULL REFERENCES hdd.chains,
  close_block bigint NOT NULL,
  close_hash bytea NOT NULL CHECK (octet_length(close_hash) = 32),
  circulating_hearts numeric(78,0) NOT NULL,
  locked_hearts numeric(78,0) NOT NULL,
  weighted_days_numerator numeric(78,0) NOT NULL,
  weighted_principal_denominator numeric(78,0) NOT NULL,
  raw_share_rate numeric(78,0) NOT NULL,
  holder_count bigint NOT NULL,
  staker_count bigint NOT NULL,
  starts integer NOT NULL,
  ends integer NOT NULL,
  penalty_hearts numeric(78,0) NOT NULL,
  payout_status text NOT NULL CHECK (payout_status IN ('pending', 'materialized')),
  payout_hearts numeric(78,0),
  payout_shares numeric(78,0),
  payout_observed_block bigint,
  payout_observed_hash bytea,
  calculation_version text NOT NULL,
  PRIMARY KEY (chain_id, contract_day),
  UNIQUE (chain_id, date_utc),
  CHECK ((payout_status = 'pending' AND payout_hearts IS NULL AND payout_shares IS NULL)
    OR (payout_status = 'materialized' AND payout_hearts IS NOT NULL AND payout_shares IS NOT NULL
    AND payout_observed_block IS NOT NULL AND payout_observed_hash IS NOT NULL AND octet_length(payout_observed_hash) = 32))
);

CREATE TABLE hdd.market_daily (
  chain_id integer NOT NULL REFERENCES hdd.chains,
  date_utc date NOT NULL,
  source text NOT NULL,
  method text NOT NULL,
  coverage text NOT NULL CHECK (coverage IN ('complete', 'partial', 'missing')),
  open_usd numeric(60,30),
  high_usd numeric(60,30),
  low_usd numeric(60,30),
  close_usd numeric(60,30),
  volume_usd numeric(60,18),
  liquidity_usd numeric(60,18),
  source_as_of timestamptz,
  assumptions jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (chain_id, date_utc, source, method)
);

CREATE TABLE hdd.market_samples (
  chain_id integer NOT NULL REFERENCES hdd.chains,
  observed_at timestamptz NOT NULL,
  block_number bigint NOT NULL,
  block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
  price_usd numeric(60,30) NOT NULL CHECK (price_usd > 0),
  method text NOT NULL,
  PRIMARY KEY (chain_id, observed_at)
);

CREATE TABLE hdd.live_metrics (
  chain_id integer NOT NULL REFERENCES hdd.chains,
  metric text NOT NULL CHECK (metric IN ('price', 'share_rate', 'completed_payout', 'estimated_payout', 'home_daily')),
  observed_at timestamptz NOT NULL,
  block_time timestamptz NOT NULL,
  block_number bigint NOT NULL,
  block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
  payload jsonb NOT NULL,
  PRIMARY KEY (chain_id, metric)
);

CREATE TABLE hdd.export_bundles (
  id uuid PRIMARY KEY,
  chain_id integer NOT NULL REFERENCES hdd.chains,
  created_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('building', 'current', 'prior', 'retired')),
  index_block bigint NOT NULL,
  index_hash bytea NOT NULL CHECK (octet_length(index_hash) = 32),
  daily_through integer,
  market_through date,
  format_version integer NOT NULL,
  calculation_version text NOT NULL,
  coverage jsonb NOT NULL
);

CREATE TABLE hdd.export_files (
  bundle_id uuid NOT NULL REFERENCES hdd.export_bundles,
  dataset text NOT NULL CHECK (dataset IN ('daily', 'stakes', 'holders', 'maturities', 'markets')),
  relative_path text NOT NULL,
  row_count bigint NOT NULL CHECK (row_count >= 0),
  byte_count bigint NOT NULL CHECK (byte_count >= 0),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  PRIMARY KEY (bundle_id, dataset)
);

CREATE TABLE hdd.job_runs (
  id uuid PRIMARY KEY,
  chain_id integer REFERENCES hdd.chains,
  job text NOT NULL,
  started_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  ended_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'complete', 'retrying', 'failed', 'cancelled')),
  progress jsonb NOT NULL DEFAULT '{}',
  error_code text,
  error_summary text
);

CREATE INDEX blocks_recent_time ON hdd.blocks_recent(chain_id, timestamp);
CREATE INDEX events_stake ON hdd.events(origin_chain_id, stake_id, block_number, log_index) WHERE stake_id IS NOT NULL;
CREATE INDEX transfers_recent_time ON hdd.transfers_recent(origin_chain_id, block_time);
CREATE INDEX undo_recent_time ON hdd.undo_recent(chain_id, block_time);
CREATE INDEX stakes_address ON hdd.stakes(chain_id, address, stake_id);
CREATE INDEX stakes_maturity ON hdd.stakes(chain_id, (locked_day + staked_days), stake_id) WHERE end_block IS NULL AND good_accounting_block IS NULL;
CREATE INDEX accounts_liquid_rank ON hdd.accounts(chain_id, liquid_rank, address) WHERE liquid_rank IS NOT NULL;
CREATE UNIQUE INDEX one_current_export ON hdd.export_bundles(chain_id) WHERE state = 'current';
CREATE UNIQUE INDEX one_prior_export ON hdd.export_bundles(chain_id) WHERE state = 'prior';
CREATE INDEX job_runs_started ON hdd.job_runs(started_at);

COMMIT;
-- Grants/role creation and migration ledger are in task02, not automatic scaffold startup.
